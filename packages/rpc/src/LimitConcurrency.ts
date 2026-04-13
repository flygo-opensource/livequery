import { catchError, EMPTY, finalize, from, lastValueFrom, mergeMap, Observable, of, Subject, Subscriber, tap } from "rxjs"



type ThenableObservable<T> = Observable<T> & PromiseLike<T>

export const LimitConcurrency = <T extends (...args: any[]) => any>(limit: number = 1) =>
    (_target: object, _propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T> => {
    const originalMethod = descriptor.value
    if (!originalMethod) return descriptor
    const sj = new Subject<{ args: any, o: Subscriber<any> }>()
    sj.pipe(
        mergeMap(async ({ args, o }) => {
            try {
                const result = await originalMethod.apply(this, args)
                const observable = result instanceof Promise ? from(result) : (result instanceof Observable ? result : of(result))
                await lastValueFrom(observable.pipe(
                    tap(data => o.next(data)),
                    catchError(e => {
                        o.error(e)
                        return EMPTY
                    }),
                    finalize(() => o.complete())
                ), { defaultValue: null })
            } catch (e) {
                o.error(e)
            }
        }, Math.max(1, limit))
    ).subscribe()

    const ovf = function (this: unknown, ...args: Parameters<T>): ThenableObservable<any> {
        const o = new Observable(o => {
            sj.next({ args, o })
        })
        return Object.assign(o, {
            async then<TResult1 = any, TResult2 = never>(
                onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
            ): Promise<TResult1 | TResult2> {
                try {
                    const r = await lastValueFrom(o, { defaultValue: null })
                    return Promise.resolve(onfulfilled ? onfulfilled(r) : (r as TResult1))
                } catch (e) {
                    if (onrejected) return Promise.resolve(onrejected(e))
                    return Promise.reject(e)
                }
            }
        })
    }

    descriptor.value = ovf as unknown as T
    return descriptor
}