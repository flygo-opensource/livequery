import { pipe, mergeMap, firstValueFrom, Observable } from "rxjs"
import { ApiRequest } from "../RestTransporter"

export const AddHeadersHook = (get_headers: any) => {
    return next => pipe(
        mergeMap(async (r: ApiRequest) => {
            const headers = typeof get_headers == 'function' ? await firstValueFrom(get_headers()) : (
                get_headers instanceof Observable ? await firstValueFrom(get_headers) : get_headers
            )
            return {
                ...r,
                options: {
                    ...r.options || {},
                    headers: {
                        ...r.options?.headers || {},
                        ...headers
                    }
                }
            }
        }),
        next()
    )
}