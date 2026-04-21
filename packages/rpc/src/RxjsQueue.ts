import { mergeMap, Subject, switchMap } from "rxjs";



export class RxjsQueue {

    #limit$ = new Subject<number>()

    #task = new Subject<{
        fn: Function,
        s: (value: any) => void
        r: (error: any) => void
    }>()
    constructor(limit?: number) {
        this.#limit$.pipe(
            switchMap(limit => (
                this.#task.pipe(
                    mergeMap(async ({ fn, s, r }) => {
                        try {
                            const data = await fn()
                            s(data)
                        } catch (e) {
                            r(e)
                        }
                    }, limit)
                )
            ))
        ).subscribe()
        limit && limit >= 1 && this.#limit$.next(limit)
    }

    updateLimit(limit: number) {
        this.#limit$.next(limit)
    }

    run(fn: () => Promise<any>) {
        return new Promise((s, r) => {
            this.#task.next({
                fn,
                s,
                r
            })
        })
    }
}