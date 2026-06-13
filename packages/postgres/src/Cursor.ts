export class Cursor {

    static caculate(item: Record<string, any>, options: Record<string, any>) {
        if (!item) return null
        const map = (
            Object
                .entries(options)
                .filter(([k, v]) => k.endsWith(':sort'))
                .map(([k, v]) => {
                    const key = k.split(':sort')[0]
                    return {
                        key: key == 'id' ? 'id' : key,
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

    static parse(cursor: string) {
        if (!cursor) return null
        return JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'))
    }
}
