// Inlined from @livequery/types so core has no dependency on that package, and so
// honojs/nestjs datasource contracts can source these types from core too.

export type LivequeryBaseEntity = {
    id: string
}

export type UpdatedDataType = 'added' | 'removed' | 'modified'

export type UpdatedData<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
    data: Partial<T> & { id: string }
    type: UpdatedDataType
    ref: string
}

// Gateway-level sync payload (old/new ref + data form). Consumed by the honojs/nestjs
// `LivequeryDatasource` Subject contract.
export type WebsocketSyncPayload<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
    type: UpdatedDataType
    old_ref?: string
    new_ref?: string
    old_data?: T
    new_data?: T
}

// Raw change-feed event shape (table + before/after rows).
export type DatabaseEvent<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
    table: string
    type: UpdatedDataType
    new_data?: Partial<T>
    old_data?: T
}

export type Paging = {
    cursor: {
        last: string | null
        first: string | null
    }
    has: {
        prev: boolean
        next: boolean
    }
    count: {
        prev: number
        next: number
        current: number
        total: number
    }
    page: {
        current: number
        total: number
    }
}
