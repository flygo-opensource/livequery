import type { ChangeStream, Collection, Db, MongoClient } from 'mongodb'
import { EMPTY, Observable, from, map, mergeAll, mergeMap, retry } from 'rxjs'
import type { LivequeryBaseEntity, WebsocketSyncPayload } from './types.js'
import type { MongoDatasourceConfig, RouteOptions } from './MongoDatasource.js'

export type MongoRealtimeChangeType = 'added' | 'modified' | 'removed'

export type MongoRealtimeRefField = string | {
    field: string
    array?: boolean
}

export type MongoRealtimeOptions = {
    enablePreAndPostImages?: boolean
}

export type MongoRealtimeRoute = {
    path: string
    method: string | number
    options?: RouteOptions
    config?: RouteOptions
} & Partial<RouteOptions>

type MongoDocumentChange = {
    operationType: string
    ns: { db: string, coll: string }
    fullDocumentBeforeChange?: Record<string, any>
    fullDocument?: Record<string, any>
    updateDescription?: {
        updatedFields?: Record<string, any>
        removedFields?: string[]
    }
}

type DatabaseEvent<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
    table: string
    type: MongoRealtimeChangeType
    new_data?: T
    old_data?: T
    fields: Set<string>
}

type RefMetadata = {
    collection: string
    field?: string
    array?: boolean
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

    #reformatId<T extends LivequeryBaseEntity>(obj: Record<string, any> | undefined): T | undefined {
        if (!obj) return undefined
        const { _id, __v, id, ...rest } = obj
        return {
            id: _id ? String(_id) : id || '#',
            ...Object.entries(rest).reduce((acc, [key, value]) => {
                if (key.startsWith('_')) return acc
                return { ...acc, [key]: value }
            }, {}),
        } as T
    }

    #isGetRoute(method: string | number) {
        return method === 0 || String(method).toUpperCase() === 'GET'
    }

    #getRouteOptions(route: MongoRealtimeRoute): RouteOptions | undefined {
        if (route.options) return route.options
        if (route.config) return route.config
        const { method: _method, path: _path, options: _options, config: _config, ...options } = route
        return options.collection ? options as RouteOptions : undefined
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
            const options = this.#getRouteOptions(route)
            if (!options?.realtime || !this.#isGetRoute(route.method)) continue
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

    #listenRawChanges<T extends LivequeryBaseEntity>(
        config: MongoDatasourceConfig,
        routes: MongoRealtimeRoute[]
    ) {
        const sources = this.#watchSources(config, routes)
        if (sources.length === 0) return EMPTY

        return from(sources).pipe(
            mergeMap(async source => {
                const collection = this.#collection(source)
                if (this.options.enablePreAndPostImages !== false) {
                    await collection.db.command({
                        collMod: source.collection,
                        changeStreamPreAndPostImages: { enabled: true },
                    })
                }
                return new Observable<DatabaseEvent<T>>(observer => {
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
                                new_data: this.#reformatId<T>(change.fullDocument),
                                old_data: this.#reformatId<T>(change.fullDocumentBeforeChange),
                                fields,
                            })
                        })

                    return () => {
                        void stream.close()
                    }
                })
            }),
            mergeMap(stream => stream),
            retry()
        )
    }

    #routeRefMetadata(route: MongoRealtimeRoute): [string, RefMetadata[]] | undefined {
        const options = this.#getRouteOptions(route)
        if (!options?.realtime || !this.#isGetRoute(route.method)) return
        if (typeof options.collection != 'string') return

        const segments = route.path.split('/').filter(Boolean)
        const collectionSegments = segments.length % 2 === 0 ? segments.slice(0, -1) : segments
        const ref = collectionSegments.map(segment => segment.startsWith(':') ? '' : segment).filter(Boolean).join('/')
        if (!ref) return

        const metadata = collectionSegments
            .map((collection, index): RefMetadata[] => {
                if (index % 2 === 1) return []
                const param = collectionSegments[index + 1]
                if (!param?.startsWith(':')) return [{ collection }]

                const paramName = param.slice(1)
                const mapped = options.refFields?.[paramName] || paramName
                const field = typeof mapped == 'string' ? mapped : mapped.field
                const array = typeof mapped == 'string' ? undefined : mapped.array
                return [{ collection, field: field == 'id' ? '_id' : field, array }]
            })
            .flat()

        return [ref, metadata]
    }

    #paths(routes: MongoRealtimeRoute[]) {
        return routes.reduce((paths, route) => {
            const options = this.#getRouteOptions(route)
            const entry = this.#routeRefMetadata(route)
            if (!options || !entry || typeof options.collection != 'string') return paths

            const [ref, metadata] = entry
            const refs = paths.get(options.collection) || new Map<string, RefMetadata[]>()
            refs.set(ref, metadata)
            paths.set(options.collection, refs)
            return paths
        }, new Map<string, Map<string, RefMetadata[]>>())
    }

    #format(paths: Map<string, Map<string, RefMetadata[]>>, event: DatabaseEvent): WebsocketSyncPayload[] {
        const refs = paths.get(event.table)
        if (!refs) return []

        const merged = {
            ...event.old_data || {},
            ...event.new_data || {},
        } as Record<string, any> & { id: string }

        const changes = Object.keys(merged)
            .filter(key => event.fields.has(key))
            .reduce((acc, key) => ({ ...acc, [key]: event.new_data?.[key] }), { id: merged.id } as Record<string, any>)

        const typeForField = (field: string, pathValue: string): MongoRealtimeChangeType => {
            const oldValue = event.old_data?.[field]
            const newValue = event.new_data?.[field]
            const value = String(pathValue)
            if (Array.isArray(oldValue) || Array.isArray(newValue)) {
                const oldArray = (Array.isArray(oldValue) ? oldValue : []).map(item => String(item))
                const newArray = (Array.isArray(newValue) ? newValue : []).map(item => String(item))
                if (oldArray.includes(value) && !newArray.includes(value)) return 'removed'
                if (!oldArray.includes(value) && newArray.includes(value)) return 'added'
                return 'modified'
            }
            if (String(newValue) == value && String(oldValue) != value) return 'added'
            if (String(oldValue) == value && String(newValue) != value) return 'removed'
            return 'modified'
        }

        const buildRefs = ([{ array, collection, field }, ...fields]: RefMetadata[]): Array<{ refs: string[], type: MongoRealtimeChangeType }> => {
            if (fields.length === 0 || !field) return [{ refs: [collection], type: event.type }]
            const values: string[] = array
                ? Array.isArray(merged[field])
                    ? [...new Set([
                        ...(event.old_data?.[field]?.map((item: any) => String(item)) || []),
                        ...(event.new_data?.[field]?.map((item: any) => String(item)) || []),
                    ])]
                    : ['-']
                : [merged[field] ?? '-']

            return values.flatMap(value => {
                return buildRefs(fields).map(next => ({
                    type: event.type == 'added' || event.type == 'removed'
                        ? event.type
                        : next.type == 'added' || next.type == 'removed'
                            ? next.type
                            : typeForField(field, value),
                    refs: [collection, String(value), ...next.refs],
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

    watch(config: MongoDatasourceConfig, routes: MongoRealtimeRoute[]): Observable<WebsocketSyncPayload> {
        const paths = this.#paths(routes)
        if (paths.size === 0) return EMPTY
        return this.#listenRawChanges(config, routes).pipe(
            map(event => this.#format(paths, event)),
            mergeAll()
        )
    }
}
