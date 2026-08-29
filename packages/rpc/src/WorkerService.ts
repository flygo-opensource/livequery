import type { BehaviorSubject, Observable } from "rxjs";

export type WorkerService<T> = {
    [k in keyof T]: T[k] extends BehaviorSubject<infer U> ? BehaviorSubject<U> : (
        T[k] extends Observable<infer U> ? Observable<U> : (
            T[k] extends (...args: infer Args) => infer R ? (
                (...args: Args) => Awaited<R> extends Observable<any> ? R : Promise<R>
            ) : (
                T[k] extends object ? T[k] : never
            )
        )
    )
};