import type { ChangeStream, Collection, Db, MongoClient } from 'mongodb'
import { EMPTY, Observable, from, map, mergeAll, mergeMap, retry, timer } from 'rxjs'
import type { UpdatedData } from '@livequery/core'
import type { MongoDatasourceConfig, RouteOptions } from './MongoDatasource.js'
import { fromMongoId } from './helpers/index.js'

export type MongoRealtimeChangeType = 'added' | 'modified' | 'removed'

export type MongoRealtimeFailure = {
    // 'collMod': enabling pre/post images failed; the watcher still starts, but deletes carry
    // only the document id. 'watch': the change stream dropped and is being resubscribed.
    stage: 'collMod' | 'watch'
    collection?: string
    // Consecutive resubscribe attempts, for 'watch' only.
    attempt?: number
}

export type MongoRealtimeOptions = {
    enablePreAndPostImages?: boolean
    // Base backoff before resubscribing after the change stream drops (default 1000ms). The
    // delay grows exponentially per consecutive failure, capped at maxReconnectDelayMs.
    reconnectDelayMs?: number
    // Upper bound for the resubscribe backoff (default 30000ms).
    maxReconnectDelayMs?: number
    // Called on every failure the watcher absorbs. Without it, failures are logged to the
    // console — they must not be silent, because the only other symptom is CPU.
    onError?: (error: unknown, failure: MongoRealtimeFailure) => void
}

export type MongoRealtimeRoute = {
    // Route path parsed by @livequery/core's LivequeryRequestParser (`parse(...).schema`):
    // document-id segment already stripped, e.g. 'users/:userId/posts'.
    schema: string
    options: RouteOptions
}

type MongoDocumentChange = {
    operationType: string
    ns: { db: string, coll: string }
    documentKey?: { _id: unknown }
    fullDocumentBeforeChange?: Record<string, any>
    fullDocument?: Record<string, any>
    updateDescription?: {
        updatedFields?: Record<string, any>
        removedFields?: string[]
    }
}

type DatabaseEvent = {
    table: string
    type: MongoRealtimeChangeType
    new_data?: Record<string, any>
    old_data?: Record<string, any>
    fields: Set<string>
}

type RefMetadata = {
    collection: string
    field?: string
}

type WatchSource = {
    connection: MongoClient | Db
    dbName?: string
    collection: string
}

const changeTypes: Record<string, MongoRealtimeChangeType | undefined> = {
    insert: 'added',
    update: 'modified',
    replace: 'modified',
    delete: 'removed',
}

export class MongodbRealtime {
    constructor(private options: MongoRealtimeOptions = {}) { }

    // Collections whose collMod failed. The cause is a missing privilege, which does not change
    // while the process runs, so retrying it on every resubscribe only costs a doomed command.
    #preImagesUnavailable = new Set<string>()

    #report(error: unknown, failure: MongoRealtimeFailure): void {
        if (this.options.onError) return this.options.onError(error, failure)
        console.error(JSON.stringify({
            event: 'livequery_mongodb_realtime_error',
            ...failure,
            message: error instanceof Error ? error.message : String(error),
        }))
    }

    #reformatId(obj: Record<string, any> | undefined): Record<string, any> | undefined {
        if (!obj) return undefined
        const { _id, __v, id, ...rest } = obj
        return {
            id: _id ? fromMongoId(_id) : id || '#',
            ...Object.entries(rest).reduce((acc, [key, value]) => {
                if (key.startsWith('_')) return acc
                return { ...acc, [key]: value }
            }, {}),
        }
    }

    #isDb(connection: MongoClient | Db): connection is Db {
        return typeof (connection as Db).collection == 'function'
    }

    #collection(source: WatchSource): Collection {
        if (this.#isDb(source.connection)) return source.connection.collection(source.collection)
        return source.connection.db(source.dbName).collection(source.collection)
    }

    #watchSources(config: MongoDatasourceConfig, routes: MongoRealtimeRoute[]) {
        const sources = new Map<string, WatchSource>()

        for (const route of routes) {
            const options = route.options
            if (!options?.realtime) continue
            if (typeof options.collection != 'string') continue
            if (typeof options.connection == 'function' || typeof options.db == 'function') continue

            const connectionName = options.connection || Object.keys(config.connections)[0] || 'default'
            const connection = config.connections[connectionName]
            if (!connection) continue

            const dbNames = this.#isDb(connection)
                ? [undefined]
                : options.db ? [options.db] : config.databases || ['main']

            for (const dbName of dbNames) {
                const key = `${connectionName}|${dbName || ''}|${options.collection}`
                sources.set(key, { connection, dbName, collection: options.collection })
            }
        }

        return [...sources.values()]
    }

    #listenRawChanges(
        config: MongoDatasourceConfig,
        routes: MongoRealtimeRoute[]
    ) {
        const sources = this.#watchSources(config, routes)
        if (sources.length === 0) return EMPTY

        return from(sources).pipe(
            mergeMap(async source => {
                const collection = this.#collection(source)
                const key = `${source.dbName || ''}|${source.collection}`
                if (this.options.enablePreAndPostImages !== false && !this.#preImagesUnavailable.has(key)) {
                    try {
                        await collection.db.command({
                            collMod: source.collection,
                            changeStreamPreAndPostImages: { enabled: true },
                        })
                    } catch (error) {
                        // collMod needs a privilege `readWrite` does not grant, and it is only an
                        // optimisation: without pre-images `old_data` falls back to documentKey.
                        // Letting it throw used to tear down the whole pipe, and the retry below
                        // re-issued the same doomed command as fast as the driver allowed.
                        this.#preImagesUnavailable.add(key)
                        this.#report(error, { stage: 'collMod', collection: source.collection })
                    }
                }
                return new Observable<DatabaseEvent>(observer => {
                    const stream = collection.watch([], {
                        fullDocument: 'updateLookup',
                        fullDocumentBeforeChange: 'whenAvailable',
                    }) as ChangeStream & { on(event: string, listener: (...args: any[]) => void): any }

                    stream
                        .on('error', error => observer.error(error))
                        .on('change', (change: MongoDocumentChange) => {
                            const type = changeTypes[change.operationType]
                            if (!type) return
                            const fields = new Set(type == 'modified'
                                ? [
                                    ...Object.keys(change.updateDescription?.updatedFields || {}).map(field => field.split('.')[0]),
                                    ...(change.updateDescription?.removedFields || []).map(field => field.split('.')[0]),
                                ].filter(field => !field.startsWith('_'))
                                : []
                            )
                            observer.next({
                                table: change.ns.coll,
                                type,
                                new_data: this.#reformatId(change.fullDocument),
                                // Delete events carry no fullDocumentBeforeChange unless the
                                // collection has pre/post images enabled (collMod privilege).
                                // Fall back to documentKey so `removed` always carries an id.
                                old_data: this.#reformatId(change.fullDocumentBeforeChange ?? change.documentKey),
                                fields,
                            })
                        })

                    return () => {
                        void stream.close()
                    }
                })
            }),
            mergeMap(stream => stream)
        )
    }

    #routeRefMetadata(route: MongoRealtimeRoute): [string, RefMetadata[]] | undefined {
        const options = route.options
        if (!options?.realtime) return
        if (typeof options.collection != 'string') return

        const segments = route.schema.split('/').filter(Boolean)
        const ref = segments.filter(segment => !segment.startsWith(':')).join('/')
        if (!ref) return

        const metadata = segments
            .map((collection, index): RefMetadata[] => {
                if (index % 2 === 1) return []
                const param = segments[index + 1]
                if (!param?.startsWith(':')) return [{ collection }]

                const field = param.slice(1)
                return [{ collection, field: field == 'id' ? '_id' : field }]
            })
            .flat()

        return [ref, metadata]
    }

    #paths(routes: MongoRealtimeRoute[]) {
        return routes.reduce((paths, route) => {
            const options = route.options
            const entry = this.#routeRefMetadata(route)
            if (!options || !entry || typeof options.collection != 'string') return paths

            const [ref, metadata] = entry
            const refs = paths.get(options.collection) || new Map<string, RefMetadata[]>()
            refs.set(ref, metadata)
            paths.set(options.collection, refs)
            return paths
        }, new Map<string, Map<string, RefMetadata[]>>())
    }

    #format(paths: Map<string, Map<string, RefMetadata[]>>, event: DatabaseEvent): UpdatedData<any>[] {
        const refs = paths.get(event.table)
        if (!refs) return []

        const merged = {
            ...event.old_data || {},
            ...event.new_data || {},
        } as Record<string, any> & { id: string }

        const changes = Object.keys(merged)
            .filter(key => event.fields.has(key))
            .reduce((acc, key) => ({ ...acc, [key]: event.new_data?.[key] }), { id: merged.id } as Record<string, any>)

        const toValues = (value: unknown): string[] =>
            Array.isArray(value) ? value.map(item => fromMongoId(item)) : value == null ? [] : [fromMongoId(value)]

        const buildRefs = ([{ collection, field }, ...fields]: RefMetadata[]): Array<{ refs: string[], type: MongoRealtimeChangeType }> => {
            if (fields.length === 0 || !field) return [{ refs: [collection], type: event.type }]

            const before = new Set(toValues(event.old_data?.[field]))
            const after = new Set(toValues(event.new_data?.[field]))
            // A parent ref is a list of its own: when an update moves a document between
            // parents — a scalar owner changing, or an element leaving or joining an array —
            // the document is `removed` under the parent it left and `added` under the one it
            // joined. Only a parent it stayed under sees `modified`.
            const fallback = () => {
                const values = toValues(merged[field])
                return values.length > 0 ? values : ['-']
            }
            const values = event.type === 'modified'
                ? [...new Set([...before, ...after])].map(value => ({
                    value,
                    type: (before.has(value) && after.has(value) ? 'modified'
                        : after.has(value) ? 'added'
                            : 'removed') as MongoRealtimeChangeType,
                }))
                // An insert carries no pre-image and a delete no post-image, so there is
                // nothing to diff: every parent sees the event as it is.
                : [...(event.type === 'added' ? after : before)]
                    .reduce<string[]>((p, c) => [...p, c], [])
                    .map(value => ({ value, type: event.type }))

            const resolved = values.length > 0
                ? values
                : fallback().map(value => ({ value, type: event.type }))

            return resolved.flatMap(({ value, type }) => {
                return buildRefs(fields).map(next => ({
                    // A deeper parent only refines a ref the document stayed under.
                    type: type === 'modified' ? next.type : type,
                    refs: [collection, value, ...next.refs],
                }))
            })
        }

        return [...refs.values()].flatMap(metadata => {
            return buildRefs(metadata).map(({ refs, type }) => ({
                ref: refs.join('/'),
                type,
                data: type == 'added' ? merged : {
                    ...type == 'modified' ? changes : {},
                    id: merged.id,
                },
            }))
        })
    }

    watch(config: MongoDatasourceConfig, routes: MongoRealtimeRoute[]): Observable<UpdatedData<any>> {
        const paths = this.#paths(routes)
        if (paths.size === 0) return EMPTY
        const base = this.options.reconnectDelayMs ?? 1000
        const cap = this.options.maxReconnectDelayMs ?? 30000
        return this.#listenRawChanges(config, routes).pipe(
            // Resubscribe on a dropped change stream with exponential backoff. A bare retry()
            // here resubscribed with no delay and no ceiling, which turns any persistent failure
            // into a busy loop against mongod.
            retry({
                delay: (error, count) => {
                    this.#report(error, { stage: 'watch', attempt: count })
                    return timer(Math.min(cap, base * 2 ** (count - 1)))
                },
                // A stream that delivered again starts the backoff over: a drop after hours of
                // uptime is not retried at the cap.
                resetOnSuccess: true,
            }),
            map(event => this.#format(paths, event)),
            mergeAll()
        )
    }
}
