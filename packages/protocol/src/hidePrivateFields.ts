import type { CollectionResponse, DocumentResponse } from "./LivequeryContext.js"


export function hidePrivateFieldsInItem<T extends {}>(item: T) {
    return Object.entries(item).reduce((p, [k, v]) => {
        if (k === '_id') {
            if (p.id === undefined) p.id = v
            return p
        }
        if (k.startsWith('_')) return p
        p[k] = v
        return p
    }, {} as Record<string, any>)
}

export const hidePrivateFields = <T extends {}>(data: CollectionResponse<T> | DocumentResponse<T>): Record<string, any> => {
    if ('items' in data) {
        return {
            ...data,
            items: data.items.map(item => hidePrivateFieldsInItem(item))
        }
    }

    if ('item' in data) {
        return {
            ...data,
            item: hidePrivateFieldsInItem(data.item)
        }
    }

    return hidePrivateFieldsInItem(data)
} 
