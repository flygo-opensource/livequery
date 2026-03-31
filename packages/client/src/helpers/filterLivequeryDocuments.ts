import type { LivequeryDocument, LivequeryFilters } from "../types"

type Primitive = string | number | boolean | null | undefined

export type LivequeryFilterInput<T extends LivequeryDocument> = Partial<LivequeryFilters<T>> | Record<string, any>

export function filterLivequeryDocuments<T extends LivequeryDocument>(
    documents:T[],
    filters?: LivequeryFilterInput<T>
): T[] {
    if (!filters) return documents
    const normalized = filters as Record<string, any>
    return documents.filter((doc) => matchesAllFilters(doc, normalized))
}

export function matchesAllFilters<T extends LivequeryDocument>(doc: T, filters: Record<string, any>) {
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
        case 'gt':
            return asNumber(actual) > asNumber(expected)
        case 'gte':
            return asNumber(actual) >= asNumber(expected)
        case 'lt':
            return asNumber(actual) < asNumber(expected)
        case 'lte':
            return asNumber(actual) <= asNumber(expected)
        case 'eq-number':
            return asNumber(actual) === asNumber(expected)
        case 'in':
            return Array.isArray(expected) ? expected.includes(actual as Primitive) : false
        case 'nin':
            return Array.isArray(expected) ? !expected.includes(actual as Primitive) : true
        case 'include':
            return Array.isArray(actual) ? actual.includes(expected) : false
        case 'boolean':
            return matchBoolean(actual, expected)
        case 'like':
            return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase())
        case 'null':
            return expected === 'null-only'
                ? (actual === null || typeof actual === 'undefined')
                : (actual !== null && typeof actual !== 'undefined')
        case 'eq':
        default:
            return actual === expected
    }
}

function matchBoolean(actual: unknown, expected: unknown) {
    switch (expected) {
        case 'true':
            return actual === true
        case 'false':
            return actual === false
        case 'not-true':
            return actual !== true
        case 'not-false':
            return actual !== false
        default:
            return false
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