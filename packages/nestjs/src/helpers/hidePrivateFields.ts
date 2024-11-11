import { LivequeryBaseEntity } from "@livequery/types"



export const hidePrivateFields = <T extends LivequeryBaseEntity>(data: T & { _id?: string }) => {
    return Object.entries(data).reduce((p, [k, v]) => {
        if (k.startsWith('_')) return p
        return { ...p, [k]: v }
    }, { id: data.id || data._id?.toString() })
}