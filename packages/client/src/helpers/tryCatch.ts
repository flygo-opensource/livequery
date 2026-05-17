import type { DocError } from "../types.js"

export const tryCatch = async <T>(fn: () => Promise<T>, transporter_id: string = ''): Promise<[DocError | undefined, T | undefined]> => {
    try {
        const result = await fn()
        return [undefined, result]
    } catch (error) {
        const e = error as any
        return [{
            code: e?.code || e?.name || 'UNKNOWN_ERROR',
            message: e?.message || 'An error occurred',
            transporter_id
        }, undefined]
    }
}