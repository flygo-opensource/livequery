import type { LivequeryRequest } from '@livequery/core'
import { MAX_IN_VALUES } from './const.js'
import { Cursor } from './Cursor.js'
import { assertColumn } from './helpers/assertColumn.js'
import { assertTable } from './helpers/assertTable.js'
import type { D1CollectionResult, D1DocumentResult, QueryPlan } from './types.js'

type SqlFragment = { clause: string; params: unknown[] }
type Sort = { field: string; asc: boolean }

/**
 * Builds and runs the SQL for one D1 table.
 *
 * Every table and column name is validated with `assertTable` / `assertColumn` before it is
 * interpolated, because D1 can only bind values. Pass `fields` to restrict which columns a
 * client may filter, sort or write; without it any well-formed identifier is accepted.
 */
export class D1Query {

    static #parseArray(value: unknown): unknown[] {
        if (Array.isArray(value)) return value
        if (typeof value !== 'string') return []
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : [parsed]
        } catch {
            return value.split(',').map(v => v.trim()).filter(Boolean)
        }
    }

    static #parseInValues(field: string, value: unknown): unknown[] {
        const arr = this.#parseArray(value)
        if (arr.length > MAX_IN_VALUES) {
            throw {
                status: 400,
                code: 'TOO_MANY_VALUES',
                message: `Filter "${field}" accepts at most ${MAX_IN_VALUES} values`,
            }
        }
        return arr
    }

    static #getLimit(query: Record<string, unknown>): number {
        const l = Number(query[':limit'])
        if (isNaN(l) || l < 1) return 10
        return Math.min(l, 100)
    }

    static #getSorts(query: Record<string, unknown>, fields?: readonly string[]): Sort[] {
        const sorts: Sort[] = []
        for (const [k, v] of Object.entries(query)) {
            if (!k.endsWith(':sort')) continue
            const field = assertColumn(k.slice(0, -5), fields)
            if (field === 'id') {
                // id sort goes at the end as tiebreaker
                continue
            }
            sorts.push({ field, asc: v === 'asc' || v === '1' || v === 1 })
        }
        // Always append id as the final tiebreaker
        const idEntry = Object.entries(query).find(([k]) => k === 'id:sort')
        sorts.push({ field: 'id', asc: idEntry ? (idEntry[1] === 'asc') : false })
        return sorts
    }

    static #buildOrderBy(sorts: Sort[], reverse = false): string {
        return 'ORDER BY ' + sorts
            .map(({ field, asc }) => `${field} ${(asc !== reverse) ? 'ASC' : 'DESC'}`)
            .join(', ')
    }

    // Build a cursor condition: items after/before the cursor in the given sort order.
    // forward=true → `:after` (next page), forward=false → `:before` (prev page, reversed sort)
    static #buildCursorCondition(sorts: Sort[], cursor: Record<string, unknown>, forward: boolean): SqlFragment {
        const params: unknown[] = []
        // Keyset pagination: (a > ca) OR (a = ca AND b > cb) OR (a = ca AND b = cb AND id > cid)
        // For DESC sort: flip > to <
        const branches: string[] = []

        for (let i = 0; i < sorts.length; i++) {
            const { field, asc } = sorts[i]
            // When forward=true (after cursor), we want items "beyond" cursor in sort direction
            // When forward=false (before cursor / reversed sort), we want items in the opposite direction
            const wantGreater = forward ? asc : !asc
            const mainOp = wantGreater ? '>' : '<'

            if (cursor[field] === undefined || cursor[field] === null) continue

            // Build equality prefix for all previous fields
            const prefix = sorts.slice(0, i)
                .map(s => `${s.field} = ?`)
                .join(' AND ')

            const prefixParams = sorts.slice(0, i).map(s => cursor[s.field])

            const clause = prefix
                ? `(${prefix} AND ${field} ${mainOp} ?)`
                : `(${field} ${mainOp} ?)`
            branches.push(clause)
            params.push(...prefixParams, cursor[field])
        }

        if (branches.length === 0) return { clause: '', params: [] }
        return { clause: `(${branches.join(' OR ')})`, params }
    }

    static #buildWhere(
        query: Record<string, unknown>,
        keys: Record<string, unknown>,
        fields?: readonly string[]
    ): SqlFragment {
        const clauses: string[] = []
        const params: unknown[] = []

        // Route keys (e.g. user_id from /livequery/users/:user_id/posts) — skip `id` (used for doc lookup).
        // Route keys come from the route definition, not the client, so they bypass the allowlist.
        for (const [k, v] of Object.entries(keys)) {
            if (k === 'id') continue
            clauses.push(`${assertColumn(k)} = ?`)
            params.push(v)
        }

        for (const [key, value] of Object.entries(query)) {
            if (key.startsWith(':') || key.startsWith('::')) continue

            if (key.endsWith(':sort')) continue
            if (key.endsWith(':select')) continue

            if (key.endsWith(':like')) {
                const field = assertColumn(key.slice(0, -5), fields)
                clauses.push(`LOWER(${field}) LIKE LOWER(?)`)
                params.push(`%${value}%`)
                continue
            }

            const colonIdx = key.lastIndexOf(':')
            if (colonIdx === -1) {
                clauses.push(`${assertColumn(key, fields)} = ?`)
                params.push(value)
                continue
            }

            const field = assertColumn(key.slice(0, colonIdx), fields)
            const op = key.slice(colonIdx + 1)

            switch (op) {
                case 'eq':
                    clauses.push(`${field} = ?`); params.push(value); break
                case 'ne':
                    clauses.push(`${field} != ?`); params.push(value); break
                case 'gt':
                    clauses.push(`${field} > ?`); params.push(Number(value)); break
                case 'gte':
                    clauses.push(`${field} >= ?`); params.push(Number(value)); break
                case 'lt':
                    clauses.push(`${field} < ?`); params.push(Number(value)); break
                case 'lte':
                    clauses.push(`${field} <= ?`); params.push(Number(value)); break
                case 'eq-number':
                    clauses.push(`${field} = ?`); params.push(Number(value)); break
                case 'neq-number':
                    clauses.push(`${field} != ?`); params.push(Number(value)); break
                case 'eq-boolean':
                    clauses.push(`${field} = ?`); params.push(`${value}`.toLowerCase() === 'true' ? 1 : 0); break
                case 'neq-boolean':
                    clauses.push(`${field} != ?`); params.push(`${value}`.toLowerCase() === 'true' ? 1 : 0); break
                case 'eq-null':
                    clauses.push(`${field} IS NULL`); break
                case 'neq-null':
                    clauses.push(`${field} IS NOT NULL`); break
                case 'in': {
                    const arr = this.#parseInValues(field, value)
                    if (arr.length === 0) { clauses.push('0 = 1'); break }
                    clauses.push(`${field} IN (${arr.map(() => '?').join(', ')})`)
                    params.push(...arr)
                    break
                }
                case 'nin': {
                    const arr = this.#parseInValues(field, value)
                    if (arr.length === 0) break
                    clauses.push(`${field} NOT IN (${arr.map(() => '?').join(', ')})`)
                    params.push(...arr)
                    break
                }
                default:
                    throw { status: 400, code: 'INVALID_OPERATOR', message: `Unknown filter operator "${op}"` }
            }
        }

        return {
            clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
            params
        }
    }

    static #buildKeyWhere(id: string, keys: Record<string, unknown>): SqlFragment {
        const extra_keys = Object.entries(keys).filter(([k]) => k !== 'id')
        return {
            clause: ['id = ?', ...extra_keys.map(([k]) => `${assertColumn(k)} = ?`)].join(' AND '),
            params: [id, ...extra_keys.map(([, v]) => v)],
        }
    }

    static #buildQueryPlan(
        table: string,
        query: Record<string, unknown>,
        keys: Record<string, unknown>,
        limit: number,
        sorts: Sort[],
        fields?: readonly string[]
    ): QueryPlan {
        const where = this.#buildWhere(query, keys, fields)
        const orderBy = this.#buildOrderBy(sorts)

        const after = query[':after'] as string | undefined
        const before = query[':before'] as string | undefined

        if (after) {
            const cursor = Cursor.decode(after) ?? {}
            const cursorCondition = this.#buildCursorCondition(sorts, cursor, true)
            const afterWhere = cursorCondition.clause
                ? `${where.clause ? where.clause + ' AND ' : 'WHERE '}${cursorCondition.clause}`
                : where.clause

            const itemsSql = `SELECT * FROM ${table} ${afterWhere} ${orderBy} LIMIT ?`
            const itemsParams = [...where.params, ...cursorCondition.params, limit + 1]

            const beforeCursor = this.#buildCursorCondition(sorts, cursor, false)
            const beforeWhere = beforeCursor.clause
                ? `${where.clause ? where.clause + ' AND ' : 'WHERE '}${beforeCursor.clause}`
                : where.clause
            const prevCountSql = `SELECT COUNT(*) as count FROM ${table} ${beforeWhere}`
            const prevCountParams = [...where.params, ...beforeCursor.params]

            const nextCountSql = `SELECT COUNT(*) as count FROM ${table} ${afterWhere}`
            const nextCountParams = [...where.params, ...cursorCondition.params]

            return {
                itemsSql,
                itemsParams,
                prevCountSql,
                prevCountParams,
                nextCountSql,
                nextCountParams,
                limit,
                reverseItems: false,
            }
        }

        if (before) {
            const cursor = Cursor.decode(before) ?? {}
            const cursorCondition = this.#buildCursorCondition(sorts, cursor, false)
            const beforeWhere = cursorCondition.clause
                ? `${where.clause ? where.clause + ' AND ' : 'WHERE '}${cursorCondition.clause}`
                : where.clause

            const reversedOrderBy = this.#buildOrderBy(sorts, true)
            const itemsSql = `SELECT * FROM ${table} ${beforeWhere} ${reversedOrderBy} LIMIT ?`
            const itemsParams = [...where.params, ...cursorCondition.params, limit + 1]

            const afterCursor = this.#buildCursorCondition(sorts, cursor, true)
            const afterWhere = afterCursor.clause
                ? `${where.clause ? where.clause + ' AND ' : 'WHERE '}${afterCursor.clause}`
                : where.clause
            const nextCountSql = `SELECT COUNT(*) as count FROM ${table} ${afterWhere}`
            const nextCountParams = [...where.params, ...afterCursor.params]

            const prevCountSql = `SELECT COUNT(*) as count FROM ${table} ${beforeWhere}`
            const prevCountParams = [...where.params, ...cursorCondition.params]

            return {
                itemsSql,
                itemsParams,
                prevCountSql,
                prevCountParams,
                nextCountSql,
                nextCountParams,
                limit,
                reverseItems: true,
            }
        }

        // First page (no cursor)
        const itemsSql = `SELECT * FROM ${table} ${where.clause} ${orderBy} LIMIT ?`
        const itemsParams = [...where.params, limit + 1]
        const countSql = `SELECT COUNT(*) as count FROM ${table} ${where.clause}`
        const countParams = [...where.params]

        return {
            itemsSql,
            itemsParams,
            prevCountSql: countSql,
            prevCountParams: countParams,
            nextCountSql: countSql,
            nextCountParams: countParams,
            limit,
            reverseItems: false
        }
    }

    static async queryCollection<T extends { id: string }>(
        db: D1Database,
        table: string,
        req: LivequeryRequest,
        fields?: readonly string[]
    ): Promise<D1CollectionResult<T>> {
        assertTable(table)
        const query = req.query ?? {}
        const keys = req.keys ?? {}
        const limit = this.#getLimit(query)
        const sorts = this.#getSorts(query, fields)

        // Page-based pagination (non-cursor)
        const page = query[':page']
        if (page) {
            const p = Math.max(1, Number(page) || 1)
            const offset = (p - 1) * limit
            const where = this.#buildWhere(query, keys, fields)
            const orderBy = this.#buildOrderBy(sorts)

            const [itemsResult, countResult] = await db.batch([
                db.prepare(`SELECT * FROM ${table} ${where.clause} ${orderBy} LIMIT ? OFFSET ?`)
                    .bind(...where.params, limit, offset),
                db.prepare(`SELECT COUNT(*) as count FROM ${table} ${where.clause}`)
                    .bind(...where.params),
            ])

            const items = (itemsResult.results ?? []) as T[]
            const total = (countResult.results?.[0] as { count: number } | undefined)?.count ?? 0

            return {
                items,
                cursor: {
                    first: Cursor.calculate(items[0] as Record<string, unknown>, query),
                    last: Cursor.calculate(items[items.length - 1] as Record<string, unknown>, query),
                },
                has: { prev: offset > 0, next: offset + limit < total },
                count: { prev: offset, next: Math.max(0, total - offset - items.length), current: items.length, total },
                page: { current: p, total: Math.ceil(total / limit) },
            }
        }

        const plan = this.#buildQueryPlan(table, query, keys, limit, sorts, fields)
        const isFirstPage = !query[':after'] && !query[':before']

        let batchStatements: D1PreparedStatement[]
        if (isFirstPage) {
            batchStatements = [
                db.prepare(plan.itemsSql).bind(...plan.itemsParams),
                db.prepare(plan.nextCountSql).bind(...plan.nextCountParams),
            ]
        } else {
            batchStatements = [
                db.prepare(plan.itemsSql).bind(...plan.itemsParams),
                db.prepare(plan.prevCountSql).bind(...plan.prevCountParams),
                db.prepare(plan.nextCountSql).bind(...plan.nextCountParams),
            ]
        }

        const results = await db.batch(batchStatements)
        let items = (results[0].results ?? []) as T[]

        let prevCount = 0
        let nextCount = 0
        const hasMore = items.length > limit

        if (hasMore) items = items.slice(0, limit)
        if (plan.reverseItems) items = [...items].reverse()

        if (isFirstPage) {
            prevCount = 0
            nextCount = Math.max(0, ((results[1].results?.[0] as { count: number } | undefined)?.count ?? 0) - limit)
        } else if (query[':after']) {
            prevCount = (results[1].results?.[0] as { count: number } | undefined)?.count ?? 0
            nextCount = Math.max(0, ((results[2].results?.[0] as { count: number } | undefined)?.count ?? 0) - limit)
        } else {
            prevCount = Math.max(0, ((results[1].results?.[0] as { count: number } | undefined)?.count ?? 0) - limit)
            nextCount = (results[2].results?.[0] as { count: number } | undefined)?.count ?? 0
        }

        const hasNext = isFirstPage ? hasMore : (query[':after'] ? hasMore : nextCount > 0)
        const hasPrev = isFirstPage ? false : (query[':before'] ? hasMore : prevCount > 0)

        return {
            items,
            cursor: {
                first: Cursor.calculate(items[0] as Record<string, unknown>, query),
                last: Cursor.calculate(items[items.length - 1] as Record<string, unknown>, query),
            },
            has: { prev: hasPrev, next: hasNext },
            count: {
                prev: prevCount,
                next: nextCount,
                current: items.length,
                total: prevCount + items.length + nextCount,
            },
            page: { current: 1, total: 1 },
        }
    }

    static async queryDocument<T extends { id: string }>(
        db: D1Database,
        table: string,
        req: LivequeryRequest
    ): Promise<D1DocumentResult<T>> {
        assertTable(table)
        const { id, ...keysWithoutId } = req.keys ?? {}
        const extraClauses = Object.keys(keysWithoutId)
            .map(k => `${assertColumn(k)} = ?`)
            .join(' AND ')
        const extraParams = Object.values(keysWithoutId)

        const where = id
            ? `WHERE id = ?${extraClauses ? ' AND ' + extraClauses : ''}`
            : `WHERE ${extraClauses || '1=1'}`
        const params = id ? [id, ...extraParams] : extraParams

        const result = await db.prepare(`SELECT * FROM ${table} ${where} LIMIT 1`).bind(...params).first<T>()
        return { item: result ?? null }
    }

    static async insert<T extends { id: string }>(
        db: D1Database,
        table: string,
        data: Record<string, unknown>,
        fields?: readonly string[]
    ): Promise<T> {
        assertTable(table)
        const id = data.id ?? crypto.randomUUID()
        const row: Record<string, unknown> = { ...data, id }
        const cols = Object.keys(row).map(k => assertColumn(k, fields))
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map(k => row[k])

        await db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
        ).bind(...values).run()

        return row as unknown as T
    }

    static async update<T extends { id: string }>(
        db: D1Database,
        table: string,
        id: string,
        data: Record<string, unknown>,
        keys: Record<string, unknown> = {},
        fields?: readonly string[]
    ): Promise<T> {
        assertTable(table)
        const { id: _id, ...clean } = data
        const setCols = Object.keys(clean).map(k => assertColumn(k, fields))
        if (setCols.length === 0) throw { status: 400, code: 'EMPTY_UPDATE', message: 'No fields to update' }

        const setClause = setCols.map(k => `${k} = ?`).join(', ')
        const where = this.#buildKeyWhere(id, keys)

        await db.prepare(
            `UPDATE ${table} SET ${setClause} WHERE ${where.clause}`
        ).bind(...setCols.map(k => clean[k]), ...where.params).run()

        return { ...keys, ...clean, id } as unknown as T
    }

    static async delete<T extends { id: string }>(
        db: D1Database,
        table: string,
        id: string,
        keys: Record<string, unknown> = {}
    ): Promise<T> {
        assertTable(table)
        const where = this.#buildKeyWhere(id, keys)

        await db.prepare(
            `DELETE FROM ${table} WHERE ${where.clause}`
        ).bind(...where.params).run()

        return { ...keys, id } as unknown as T
    }
}
