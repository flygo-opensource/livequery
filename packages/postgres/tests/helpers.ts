// A minimal `node-postgres`-shaped mock. It records every `query(text, values)` call
// and answers with canned rows chosen by inspecting the SQL, so a single mock can serve
// a read (main SELECT + prev/next COUNT) and a write (RETURNING) in the same test.

export type MockResponses = {
    items?: any[]
    write?: any
    prev?: number
    next?: number
    total?: number
}

export type MockDb = {
    queries: Array<{ text: string, values: any[] }>
    responder?: (text: string, values: any[]) => any[]
    query: (text: string, values?: any[]) => Promise<{ rows: any[], rowCount: number }>
    last(): { text: string, values: any[] }
    find(re: RegExp): { text: string, values: any[] } | undefined
}

function defaultResponder(text: string, r: MockResponses): any[] {
    const t = text.toLowerCase()
    if (/returning/.test(t)) return r.write ? [r.write] : []
    if (/filter \(where/.test(t)) return [{ prev: r.prev ?? 0, next: r.next ?? 0 }]
    if (/as total/.test(t)) return [{ total: r.total ?? 0 }]
    if (/^\s*select/.test(t)) return r.items ?? []
    return []
}

export function createMockDb(responses: MockResponses = {}): MockDb {
    const db: MockDb = {
        queries: [],
        async query(text: string, values: any[] = []) {
            db.queries.push({ text, values })
            const rows = db.responder ? db.responder(text, values) : defaultResponder(text, responses)
            return { rows, rowCount: rows.length }
        },
        last() {
            return db.queries[db.queries.length - 1]
        },
        find(re: RegExp) {
            return db.queries.find(q => re.test(q.text))
        },
    }
    return db
}

export function baseRequest(overrides: Record<string, any> = {}) {
    return {
        method: 'get',
        ref: 'items',
        is_collection: true,
        keys: {},
        query: {},
        ...overrides,
    }
}
