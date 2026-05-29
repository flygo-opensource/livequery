import type { Doc, LivequeryFilters } from "../types.js"

export type LivequeryFilterInput<T extends Doc> = Partial<LivequeryFilters<T>> | Record<string, any>

export function filterDocs<T extends Doc>(
    documents: T[],
    filters?: LivequeryFilterInput<T>
): T[] {
    if (!filters) return documents
    const normalized = filters as Record<string, any>
    return documents.filter((doc) => matchesAllFilters(doc, normalized))
}

export function matchesAllFilters(doc: Record<string, any>, filters: Record<string, any>) {
    for (const [key, expected] of Object.entries(filters)) {
        if (key.startsWith(':') || key.endsWith(':sort')) continue

        const split = key.split(':')
        const fieldPath = split[0]
        if (!fieldPath) continue
        const op = split[1] || 'eq'
        const actual = getByPath(doc, fieldPath)

        if (!matchByOperator(actual, op, expected)) {
            return false
        }
    }
    return true
}

function matchByOperator(actual: unknown, op: string, expected: unknown) {
    switch (op) {
        case 'ne':
            return actual !== expected
        case 'gt':
            return (actual as any) > asNumber(expected)
        case 'gte':
            return (actual as any) >= asNumber(expected)
        case 'lt':
            return (actual as any) < asNumber(expected)
        case 'lte':
            return (actual as any) <= asNumber(expected)
        case 'eq-number':
            return actual === asNumber(expected)
        case 'neq-number':
            return actual !== asNumber(expected)
        case 'in':
            return parseArray(expected).includes(actual)
        case 'nin':
            return !parseArray(expected).includes(actual)
        case 'eq-boolean':
            return actual === (String(expected).toLowerCase() === 'true')
        case 'neq-boolean':
            return actual !== (String(expected).toLowerCase() === 'false' ? false : true)
        case 'eq-null':
            return actual === null
        case 'neq-null':
            return actual !== null
        case 'eq-oid':
            return String(actual) === String(expected)
        case 'neq-oid':
            return String(actual) !== String(expected)
        case 'like':
            return new RegExp(String(expected)).test(String(actual || ''))
        case 'eq':
        default:
            return actual === expected
    }
}

function parseArray(value: unknown) {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string') return []
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        console.warn(`[livequery] filter value is not valid JSON: "${value}". Expected a JSON array e.g. '["a","b"]'.`)
        return []
    }
}

function getByPath(obj: Record<string, any>, path: string) {
    if (!path.includes('.')) return obj[path]
    return path.split('.').reduce<unknown>((acc, key) => {
        if (!acc || typeof acc !== 'object') return undefined
        return (acc as Record<string, any>)[key]
    }, obj)
}

function asNumber(value: unknown) {
    return Number(value)
}
