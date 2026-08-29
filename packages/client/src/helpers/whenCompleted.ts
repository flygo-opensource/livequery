import { Subject, Observable, materialize, filter, map, shareReplay } from 'rxjs'

export function whenCompleted(stream: Subject<any>): Observable<void> {
    return stream.pipe(
        materialize(),
        filter(n => n.kind === 'C' || n.kind === 'E'),
        map(() => undefined),
        shareReplay({ bufferSize: 1, refCount: true })
    )
} 