import { LIVEQUERY_MAGIC_KEY } from "./const"

export const pathResolver = (target: Function, method: string) => {

    const collection_path: string = Reflect.getMetadata('path', target) || ''
    const method_path: string = Reflect.getMetadata('path', target.prototype[method]) || ''

    const refs = `${collection_path}/${method_path}`
        .replaceAll(':', '')
        .split(LIVEQUERY_MAGIC_KEY)?.[1]
        .split('/')
        .filter(s => s.length > 0)

    const ref = refs.join('/')
    const schema_ref = refs.filter((_, i) => i % 2 == 0).join('/')
    return { ref, schema_ref }
}