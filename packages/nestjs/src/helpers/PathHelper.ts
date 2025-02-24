import { LIVEQUERY_MAGIC_KEY } from "../const.js"


export class PathHelper {


    static trimLivequeryHotkey(path: string) {
        const ref = path
            ?.split('~')[0]
            ?.replaceAll(':', '')
            ?.split(LIVEQUERY_MAGIC_KEY)?.[1]
            ?.split('/')
            ?.filter(s => s.length > 0)
            ?.join('/')

        if (!ref) throw { code: 'LIVEQUERY_MAGIC_KEY_NOT_FOUND' }

        return ref
    }


    static parseHttpRequestPath(path: string) {
        const refs = path
            ?.split('~')[0]
            ?.replaceAll(':', '')
            ?.split(LIVEQUERY_MAGIC_KEY)?.[1]
            ?.split('/')
            ?.filter(s => s.length > 0)

        if (!refs) throw { code: 'LIVEQUERY_MAGIC_KEY_NOT_FOUND' }

        const is_collection = refs.length % 2 == 1
        const ref = refs.join('/')
        const collection_ref = is_collection ? ref : refs.slice(0, refs.length - 1).join('/')
        const schema_ref = refs.filter((_, i) => i % 2 == 0).join('/')
        const doc_id = is_collection ? null : refs[refs.length - 1]

        return { ref, schema_ref, is_collection, doc_id, collection_ref }

    }

    static join(a: string | string[], b: string | string[]) {
        return [a || '']
            .flat(2)
            .map(r1 => [b || ''].flat(2).map(r2 => `${r1}/${r2}`))
            .flat(2)
            .map(r => r.split('/')
                .filter(r => r != '')
                .join('/'))
    }

}


