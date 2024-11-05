import { pipe, mergeMap, BehaviorSubject, tap, of, filter, first } from "rxjs"
import { ApiRequest } from "../RestTransporter"

const requests = new Map<string, { time: number, response: BehaviorSubject<any> }>()

export const Deduplicate = (ms: number = 1000) => next => {

    return pipe(
        mergeMap(async (r: ApiRequest) => {

            if (r.options.method != 'GET') return of(r).pipe(
                next()
            )

            const url = r.url.toString()
            const cached = requests.get(url)

            if (cached) {
                if (cached.time > Date.now() - ms) {
                    return cached.response.pipe(
                        filter(Boolean),
                        first()
                    )
                } else {
                    requests.delete(url)
                }
            }

            requests.set(url, {
                response: new BehaviorSubject(undefined),
                time: Date.now()
            })


            return of(r).pipe(
                next(),
                tap(response => {
                    requests.get(url)?.response.next(response)
                })
            )
        }),
        mergeMap($ => $)
    )
}