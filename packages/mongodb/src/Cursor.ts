import type { LivequeryBaseEntity, QueryOption } from "./types.js"

export class Cursor {

    static caculate<T extends LivequeryBaseEntity>(item: T, options: QueryOption<T>) {
        if (!item) return null
        const map = (
            Object
                .entries(options)
                .filter(([k, v]) => k.endsWith(':sort'))
                .map(([k, v]) => {
                    const key = k.split(':sort')[0]
                    return {
                        key: key == '_id' ? 'id' : key,
                        value: v
                    }
                })
                .reduce((p, { key, value }) => {
                    const name = key.split(':sort')[0]
                    return {
                        ...p,
                        [name]: item[name] as string | number
                    }
                }, {
                    id: item.id
                })
        )

        return Buffer.from(JSON.stringify(map), 'utf8').toString('hex')
    }

    static parse<T extends LivequeryBaseEntity>(cursor: string) {
        if (!cursor) return null
        return JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'))
    }
} 
