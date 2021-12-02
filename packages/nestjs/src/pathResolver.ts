import { LIVEQUERY_MAGIC_KEY } from "./const"


export class PathHelper {

    static #toArray = (a: string | string[]) => typeof a == 'string' ? [a] : a

    static livequeryPathExtractor(path: string) {
        const refs = path
            ?.replaceAll(':', '')
            ?.split(LIVEQUERY_MAGIC_KEY)?.[1]
            ?.split('/')
            ?.filter(s => s.length > 0)
        if (!refs) return null
        const ref = refs.join('/')
        const schema_ref = refs.filter((_, i) => i % 2 == 0).join('/')
        return { ref, schema_ref }

    }

    static nestjsPathResolver(target: Function, method: string) {
        const collection_paths = this.#toArray(Reflect.getMetadata('path', target) || '')
        const method_paths = this.#toArray(Reflect.getMetadata('path', target.prototype[method]) || '')
        return collection_paths.map(
            collection_path => method_paths.map(
                method_path => `${collection_path}/${method_path}`
            )
        ).flat(2)
    }

}


