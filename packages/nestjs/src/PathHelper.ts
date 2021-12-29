import { LIVEQUERY_MAGIC_KEY } from "./const"


export class PathHelper {

    static #toArray = (a: string | string[]) => typeof a == 'string' ? [a] : a


    static livequeryPathExtractor(path: string) {
        const refs = path
            ?.replaceAll(':', '')
            ?.split(LIVEQUERY_MAGIC_KEY)?.[1]
            ?.split('/')
            ?.filter(s => s.length > 0)
        if (!refs) throw 'LIVEQUERY_MAGIC_KEY_NOT_FOUND'

        const is_collection = refs.length % 2 == 1
        const ref = refs.join('/')
        const collection_ref = is_collection ? ref : refs.slice(0, refs.length - 1).join('/')
        const schema_ref = refs.filter((_, i) => i % 2 == 0).join('/')
        const doc_id = is_collection ? null : refs[refs.length - 1]

        return { ref, schema_ref, is_collection, doc_id, collection_ref }

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


