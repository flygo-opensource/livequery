


export const tryCatch = async <T>(fn: () => Promise<T>): Promise<[Error | undefined, T | undefined]> => {
    try {
        const result = await fn()
        return [undefined, result]
    } catch (error) {
        return [error as Error, undefined]
    }
}