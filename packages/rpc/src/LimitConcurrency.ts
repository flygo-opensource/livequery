import { catchError, EMPTY, finalize, firstValueFrom, from, lastValueFrom, mergeMap, Observable, of, Subject, Subscriber, tap } from "rxjs"



export const LimitConcurrency = <T extends ((...args: any) => any)>(limit: number = 1) => (target: any, propertyKey: string, descriptor:any ) => {
    const originalMethod = descriptor.value as T
    const sj = new Subject<{ args: any, o: Subscriber<any> }>()
    sj.pipe(
        mergeMap(async ({ args, o }) => {
            try {
                const result = await originalMethod.apply(target, args)
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
        }, 1)
    ).subscribe()

    const ovf = (...args: any[]) => {
        const o = new Observable(o => {
            sj.next({ args, o })
        })
        return Object.assign(o, {
            async then(resolve: (value: any) => void, reject: (reason?: any) => void) {
                try {
                    const r = await lastValueFrom(o, { defaultValue: null })
                    resolve(r)
                } catch (e) {
                    reject(e)
                }
            }
        })
    }

    return ovf as any 
}