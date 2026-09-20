export type MockD1Options = {
    first?: Record<string, unknown> | null
    items?: Record<string, unknown>[]
    count?: number
}

export type RecordedD1Query = {
    sql: string
    values: unknown[]
}

export type MockD1Database = D1Database & {
    queries: RecordedD1Query[]
    last(): RecordedD1Query
}

export function createMockD1(options: MockD1Options = {}): MockD1Database {
    const queries: RecordedD1Query[] = []

    const db = {
        queries,
        prepare(sql: string) {
            const query: RecordedD1Query = { sql, values: [] }
            queries.push(query)

            const statement = {
                bind(...values: unknown[]) {
                    query.values = values
                    return statement
                },
                async first() {
                    return options.first ?? null
                },
                async run() {
                    return { success: true, meta: {} }
                },
                async all() {
                    return { success: true, results: options.items ?? [], meta: {} }
                },
                async raw() {
                    return []
                },
            }
            return statement
        },
        async batch(statements: Array<{ __query?: RecordedD1Query }>) {
            return statements.map((_statement, index) => {
                const query = queries[queries.length - statements.length + index]
                const results = /COUNT\(\*\)/i.test(query.sql)
                    ? [{ count: options.count ?? 0 }]
                    : options.items ?? []
                return { success: true, results, meta: {} }
            })
        },
        last() {
            return queries[queries.length - 1]
        },
    }

    return db as unknown as MockD1Database
}

export function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
        method: 'get',
        ref: 'products',
        is_collection: true,
        keys: {},
        query: {},
        ...overrides,
    }
}
