import { combineLatest, defer, distinctUntilChanged, map, of, switchMap, type BehaviorSubject } from 'rxjs'
import type { LivequeryQueryResult, LivequeryTransporter } from '../LivequeryTransporter.js'

const OFFLINE = { code: 'NETWORK_ERROR', message: 'Offline' }

/**
 * A transporter that behaves exactly like one without a network while `offline$` is true: writes
 * and reads fail with NETWORK_ERROR, realtime streams stop, and `status$` reports disconnected — so
 * turning the switch back off looks like a reconnect (outbox retries, sync catches up, streams
 * resubscribe).
 */
export function withOfflineSwitch(transporter: LivequeryTransporter, offline$: BehaviorSubject<boolean>): LivequeryTransporter {
    const guard = <R>(call: () => Promise<R>): Promise<R> => offline$.value ? Promise.reject(OFFLINE) : call()
    const failed = { error: OFFLINE, source: 'query' } as Partial<LivequeryQueryResult>
    const wrapped: LivequeryTransporter = {
        query: params => offline$.pipe(
            distinctUntilChanged(),
            switchMap(offline => offline ? of(failed) : defer(() => transporter.query(params))),
        ),
        add: (ref, doc, context) => guard(() => transporter.add(ref, doc, context)),
        update: (ref, id, doc, context, options) => guard(() => transporter.update(ref, id, doc, context, options)),
        delete: (ref, id, context) => guard(() => transporter.delete(ref, id, context)),
        trigger: action => guard(() => transporter.trigger(action)),
        status$: combineLatest([transporter.status$ ?? of({ connected: true }), offline$]).pipe(
            map(([status, offline]) => ({ connected: status.connected && !offline })),
            distinctUntilChanged((a, b) => a.connected === b.connected),
        ),
    }
    const read = transporter.read?.bind(transporter)
    if (read) wrapped.read = params => offline$.value ? Promise.resolve(failed) : read(params)
    return wrapped
}
