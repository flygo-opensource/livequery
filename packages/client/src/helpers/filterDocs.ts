import type { Doc, LivequeryFilters } from "../types.js"

export type LivequeryFilterInput<T extends Doc> = Partial<LivequeryFilters<T>> | Record<string, any>

export type ParsedFilter = { fieldPath: string; op: string; expected: unknown }

export function parseFilters(filters: Record<string, any>): ParsedFilter[] {
    const result: ParsedFilter[] = []
    for (const key of Object.keys(filters)) {
        if (key.startsWith(':') || key.endsWith(':sort')) continue
        const split = key.split(':')
        const fieldPath = split[0]
        if (!fieldPath) continue
        result.push({ fieldPath, op: split[1] || 'eq', expected: filters[key] })
    }
    return result
}

export function filterDocs<T extends Doc>(
    documents: T[],
    filters?: LivequeryFilterInput<T>
): T[] {
    if (!filters) return documents
    const parsed = parseFilters(filters as Record<string, any>)
    if (parsed.length === 0) return documents
    return documents.filter((doc) => matchesParsedFilters(doc, parsed))
}

export function matchesAllFilters(doc: Record<string, any>, filters: Record<string, any>) {
    return matchesParsedFilters(doc, parseFilters(filters))
}

export function matchesParsedFilters(doc: Record<string, any>, parsed: ParsedFilter[]) {
    for (const { fieldPath, op, expected } of parsed) {
        if (!matchByOperator(getByPath(doc, fieldPath), op, expected)) return false
    }
    return true
}

export function getByPath(obj: Record<string, any>, path: string): unknown {
    if (!path.includes('.')) return obj[path]
    return path.split('.').reduce<unknown>((acc, key) => {
        if (!acc || typeof acc !== 'object') return undefined
        return (acc as Record<string, any>)[key]
    }, obj)
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

function asNumber(value: unknown) {
    return Number(value)
}
