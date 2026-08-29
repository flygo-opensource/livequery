import { EMPTY, Observable, map, mergeAll, retry, timer } from 'rxjs'
import type { UpdatedData } from '@livequery/core'
import type { RouteOptions } from './PostgresDatasource.js'

export type PostgresRealtimeChangeType = 'added' | 'modified' | 'removed'

// A Postgres connection capable of LISTEN/NOTIFY — i.e. a dedicated `pg.Client`
// (NOT a pooled `pg.Pool`, which hands out a different physical connection per query).
export interface PgNotificationConnection {
    query(text: string, values?: any[]): Promise<any>
    on(event: 'notification' | 'error', listener: (arg: any) => void): any
    removeListener?(event: string, listener: (...args: any[]) => void): any
    end?(): Promise<void> | void
}

// Either a live connection, or a factory that produces a fresh, already-connected one on
// each (re)connect. Pass a FACTORY to get automatic reconnection after a dropped
// connection — a single `pg.Client` cannot be reused once it has errored.
export type PostgresRealtimeSource =
    | PgNotificationConnection
    | (() => PgNotificationConnection | Promise<PgNotificationConnection>)

export type PostgresRealtimeOptions = {
    // NOTIFY channel the database triggers publish to. Defaults to 'livequery'.
    channel?: string
    // Base backoff before reconnecting after a dropped connection (default 1000ms). The
    // delay grows exponentially per consecutive failure, capped at maxReconnectDelayMs.
    reconnectDelayMs?: number
    // Upper bound for the reconnect backoff (default 30000ms).
    maxReconnectDelayMs?: number
}

export type PostgresRealtimeRoute = {
    // Route path parsed by @livequery/core's LivequeryRequestParser (`parse(...).schema`):
    // document-id segment already stripped, e.g. 'users/:userId/posts'.
    schema: string
    options: RouteOptions
}

// JSON payload published by the NOTIFY trigger (see PostgresRealtime.triggerSql).
type NotifyPayload = {
    table: string
    type: 'INSERT' | 'UPDATE' | 'DELETE' | PostgresRealtimeChangeType
    old_data?: Record<string, any> | null
    new_data?: Record<string, any> | null
}

type DatabaseEvent = {
    table: string
    type: PostgresRealtimeChangeType
    new_data?: Record<string, any>
    old_data?: Record<string, any>
    fields: Set<string>
}

type RefMetadata = {
    table: string
    field?: string
}

const changeTypes: Record<string, PostgresRealtimeChangeType | undefined> = {
    INSERT: 'added',
    UPDATE: 'modified',
    DELETE: 'removed',
    added: 'added',
    modified: 'modified',
    removed: 'removed',
}

export class PostgresRealtime {
    constructor(private options: PostgresRealtimeOptions = {}) { }

    get #channel() {
        return this.options.channel || 'livequery'
    }

    // SQL to install a generic NOTIFY trigger on the given tables. The trigger publishes
    // one JSON message per row change on the realtime channel. NOTE: Postgres caps a
    // NOTIFY payload at 8000 bytes — keep watched rows small or switch to logical
    // replication for wide tables.
    static triggerSql(tables: string[], channel = 'livequery'): string {
        const fn = `livequery_notify_${channel}`
        const triggers = tables.map(table => `
DROP TRIGGER IF EXISTS ${fn}_trg ON "${table}";
CREATE TRIGGER ${fn}_trg
AFTER INSERT OR UPDATE OR DELETE ON "${table}"
FOR EACH ROW EXECUTE FUNCTION ${fn}();`).join('\n')

        return `
CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${channel}', json_build_object(
    'table', TG_TABLE_NAME,
    'type', TG_OP,
    'old_data', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE row_to_json(OLD) END,
    'new_data', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
${triggers}`
    }

    #reformatId(obj: Record<string, any> | null | undefined): Record<string, any> | undefined {
        if (!obj) return undefined
        const { id, ...rest } = obj
        return { id: id != null ? String(id) : '#', ...rest }
    }

    #toEvent(payload: NotifyPayload): DatabaseEvent | undefined {
        const type = changeTypes[payload.type]
        if (!type) return undefined

        const old_data = this.#reformatId(payload.old_data)
        const new_data = this.#reformatId(payload.new_data)

        const fields = new Set<string>(
            type == 'modified'
                ? [...new Set([...Object.keys(old_data || {}), ...Object.keys(new_data || {})])]
                    .filter(key => key != 'id' && JSON.stringify(old_data?.[key]) != JSON.stringify(new_data?.[key]))
                : []
        )

        return { table: payload.table, type, old_data, new_data, fields }
    }

    #routeRefMetadata(route: PostgresRealtimeRoute): [string, RefMetadata[]] | undefined {
        const options = route.options
        if (!options?.realtime) return
        if (typeof options.table != 'string') return

        const segments = route.schema.split('/').filter(Boolean)
        const ref = segments.filter(segment => !segment.startsWith(':')).join('/')
        if (!ref) return

        const metadata = segments
            .map((table, index): RefMetadata[] => {
                if (index % 2 === 1) return []
                const param = segments[index + 1]
                if (!param?.startsWith(':')) return [{ table }]
                const field = param.slice(1)
                return [{ table, field: field == 'id' ? (options.idField || 'id') : field }]
            })
            .flat()

        return [ref, metadata]
    }

    #paths(routes: PostgresRealtimeRoute[]) {
        return routes.reduce((paths, route) => {
            const options = route.options
            const entry = this.#routeRefMetadata(route)
            if (!options || !entry || typeof options.table != 'string') return paths

            const [ref, metadata] = entry
            const refs = paths.get(options.table) || new Map<string, RefMetadata[]>()
            refs.set(ref, metadata)
            paths.set(options.table, refs)
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

        const typeForField = (field: string, pathValue: string): PostgresRealtimeChangeType => {
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

        const buildRefs = ([{ table, field }, ...fields]: RefMetadata[]): Array<{ refs: string[], type: PostgresRealtimeChangeType }> => {
            if (fields.length === 0 || !field) return [{ refs: [table], type: event.type }]
            const oldValues = event.old_data?.[field]
            const newValues = event.new_data?.[field]
            const values: string[] = Array.isArray(oldValues) || Array.isArray(newValues)
                ? [...new Set([
                    ...(Array.isArray(oldValues) ? oldValues : []).map((item: any) => String(item)),
                    ...(Array.isArray(newValues) ? newValues : []).map((item: any) => String(item)),
                ])]
                : [merged[field] ?? '-']

            return values.flatMap(value => {
                return buildRefs(fields).map(next => ({
                    type: event.type == 'added' || event.type == 'removed'
                        ? event.type
                        : next.type == 'added' || next.type == 'removed'
                            ? next.type
                            : typeForField(field, value),
                    refs: [table, String(value), ...next.refs],
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

    #listenRawChanges(source: PostgresRealtimeSource): Observable<DatabaseEvent> {
        return new Observable<DatabaseEvent>(observer => {
            let conn: PgNotificationConnection | undefined
            let owned = false
            let disposed = false

            const onNotification = (message: { channel: string, payload?: string }) => {
                if (message.channel != this.#channel || !message.payload) return
                try {
                    const event = this.#toEvent(JSON.parse(message.payload) as NotifyPayload)
                    if (event) observer.next(event)
                } catch (error) {
                    observer.error(error)
                }
            }
            // A dropped connection surfaces as the client's 'error' event; propagate it so the
            // retry operator in watch() can reconnect (with a fresh connection from the factory).
            const onError = (error: any) => observer.error(error instanceof Error ? error : new Error(String(error)))

            void (async () => {
                try {
                    if (typeof source === 'function') {
                        conn = await source()
                        owned = true
                    } else {
                        conn = source
                    }
                    if (disposed) {
                        if (owned) await conn.end?.()
                        return
                    }
                    conn.on('notification', onNotification)
                    conn.on('error', onError)
                    await conn.query(`LISTEN "${this.#channel}"`)
                } catch (error) {
                    observer.error(error)
                }
            })()

            return () => {
                disposed = true
                const c = conn
                if (!c) return
                c.removeListener?.('notification', onNotification)
                c.removeListener?.('error', onError)
                // We only created the connection (and therefore close it) for the factory form;
                // a caller-supplied client is left open for the caller to manage.
                if (owned) void Promise.resolve(c.end?.()).catch(() => { })
                else void Promise.resolve(c.query(`UNLISTEN "${this.#channel}"`)).catch(() => { })
            }
        })
    }

    watch(source: PostgresRealtimeSource, routes: PostgresRealtimeRoute[]): Observable<UpdatedData<any>> {
        const paths = this.#paths(routes)
        if (paths.size === 0) return EMPTY
        const base = this.options.reconnectDelayMs ?? 1000
        const cap = this.options.maxReconnectDelayMs ?? 30000
        return this.#listenRawChanges(source).pipe(
            // Reconnect on a dropped connection with exponential backoff. retry() resubscribes
            // the raw change source only, so format/fan-out below is unaffected.
            retry({ delay: (_error, count) => timer(Math.min(cap, base * 2 ** (count - 1))) }),
            map(event => this.#format(paths, event)),
            mergeAll()
        )
    }
}
