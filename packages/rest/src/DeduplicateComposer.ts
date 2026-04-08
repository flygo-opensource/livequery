import { groupBy, mergeMap, Subject, timer } from "rxjs"

export type MaybePromise<T> = T | Promise<T>


export type ResolverOptrions<T> = {
    name: string
    validate?: (data: T) => MaybePromise<boolean>
    resolve: () => Promise<T>,
}


export class DeduplicateComposer {

    #map = new Map<string, { value: any }>()

    #queue = new Subject<ResolverOptrions<any> & { o: Function }>()


    constructor() {
        this.#queue.pipe(
            groupBy(r => r.name, { duration: () => timer(60000) }),
            mergeMap($ => $.pipe(
                mergeMap(async opts => {
                    for (let i = 1; i <= 2; i++) {
                        const cache = this.#map.get(opts.name)
                        const value = cache ? cache.value : await opts.resolve()
                        !cache && this.#map.set(opts.name, { value })
                        const ok = opts.validate ? await opts.validate(value) : true
                        if (ok) return opts.o(value)
                        this.#map.delete(opts.name)
                    }
                    return opts.o(null)
                }, 1)
            ))
        ).subscribe()
    }

    get<T>(opts: ResolverOptrions<T>) {
        return new Promise<T>(o => this.#queue.next({ ...opts, o }))
    }

    define<T>(opts: ResolverOptrions<T>) {
        return {
            resolve: () => this.get(opts)
        }
    }

} 