import { LivequeryBaseEntity } from "@livequery/types"



export const hidePrivateFields = <T extends LivequeryBaseEntity>(data: T & { _id?: string }) => {
    const id = data.id || data._id?.toString()
    return Object.entries(data).reduce((p, [k, v]) => {
        if (k.startsWith('_') || k === 'id') return p
        return { ...p, [k]: v }
    }, { id })
}
