


export class SmartCache {

    #storage = new Map<any, any>()

    async get<T>(key: any, resolver: () => Promise<T>) {
        const cache = this.#storage.get(key)
        if (cache) return await cache
        const value = resolver()
        this.#storage.set(key, value)
        return await value
    }
}