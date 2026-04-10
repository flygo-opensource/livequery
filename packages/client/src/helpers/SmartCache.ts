


export class SmartCache {

    #map = new Map<string, any>()

    resolve<T>(name: string, resolver: () => T) {
        const cache = this.#map.get(name)
        if (cache) return cache as T 
        const promise = resolver()
        this.#map.set(name, promise)
        return promise as T 
    }
}