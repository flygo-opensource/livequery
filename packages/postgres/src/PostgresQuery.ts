import type { LivequeryBaseEntity, LivequeryRequest, FilterConditions } from "@livequery/core"
import { Cursor } from "./Cursor.js"
import { Sql, ident, escapeLike, exec, type PgQueryable } from "./Sql.js"

// Everything PostgresQuery needs to turn a Livequery request into SQL against one
// physical table. `idField` is the primary-key column that the adapter exposes to
// clients as `id`; `searchFields` are the columns scanned by `:search`.
export type PostgresTable = {
    db: PgQueryable
    name: string          // already schema-qualified + quoted, e.g. "public"."users"
    idField: string       // physical primary key column (default 'id')
    searchFields?: string[]
}

type SortColumn = { key: string, dir: 'ASC' | 'DESC' }

export type PostgresReadResult<T> = {
    items: T[]
    limit: number
    count: { next: number, prev: number }
    has: { next: boolean, prev: boolean }
    summary: Record<string, any>
}

export class PostgresQuery {

    // --- Expression parser (shared with summary arithmetic), ported from MongoQuery ---

    static #is_operator(c: string): boolean {
        return ['+', '-', '*', '/', '(', ')', '~'].indexOf(c) !== -1
    }

    static #get_precedence(op: string): number {
        if (op == '~') return 3
        if (op === '+' || op === '-') return 1
        if (op === '*' || op === '/') return 2
        return 0
    }

    static #infix_to_postfix(expression: string): string[] {
        const stack: string[] = []
        const output: string[] = []
        let current = ''

        for (let i = 0; i < expression.length; i++) {
            const token = expression[i]
            if (this.#is_operator(token)) {
                if (current) { output.push(current); current = '' }
                if (token === '(') {
                    stack.push(token)
                } else if (token === ')') {
                    while (stack.length > 0 && stack[stack.length - 1] !== '(') output.push(stack.pop()!)
                    stack.pop()
                } else {
                    while (stack.length > 0 && this.#get_precedence(token) <= this.#get_precedence(stack[stack.length - 1])) {
                        output.push(stack.pop()!)
                    }
                    stack.push(token)
                }
            } else if (/\s/.test(token)) {
                continue
            } else {
                current += token
            }
        }
        if (current) output.push(current)
        while (stack.length > 0) output.push(stack.pop()!)
        return output
    }

    // Postfix tokens -> a parenthesized SQL arithmetic expression. Bare identifiers are
    // quoted/validated columns; `~` rounds. Numbers pass through as literals.
    static #postfix_to_sql(postfix: string[]): string {
        const stack: string[] = []
        for (const token of postfix) {
            if (!isNaN(Number(token))) {
                stack.push(String(Number(token)))
            } else if (token.includes('~')) {
                const value = stack.pop()
                stack.push(`round((${value})::numeric)`)
            } else if (this.#is_operator(token)) {
                const right = stack.pop()
                const left = stack.pop()
                const op = token === '+' ? '+' : token === '-' ? '-' : token === '*' ? '*' : '/'
                stack.push(`(${left} ${op} ${right})`)
            } else {
                stack.push(`${ident(token)}::numeric`)
            }
        }
        return stack.pop() ?? '0'
    }

    // --- Helpers ---

    static #parse_cursor(token: string) {
        try {
            return Cursor.parse(token)
        } catch {
            throw { status: 400, code: 'INVALID_CURSOR', message: 'Invalid pagination cursor' }
        }
    }

    static #parse_array(value: unknown): any[] {
        if (Array.isArray(value)) return value
        if (typeof value != 'string') return []
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }

    static #number(value: unknown): number {
        return !isNaN(Number(value)) ? Number(value) : 0
    }

    static #bool(value: unknown): boolean {
        return `${value}`.toLowerCase() == 'true'
    }

    static #get_limit<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>): number {
        const l = Number(req.query?.[':limit'])
        if (isNaN(l)) return 10
        if (l < 1) return 1
        if (l > 100) return 100
        return l
    }

    // Map the public `id` field onto the physical primary-key column.
    static #real(key: string, idField: string): string {
        return key == 'id' ? idField : key
    }

    // --- Filtering ---

    // Build a single comparison predicate for `field:op = value`. Returns '' for ops
    // we don't translate (e.g. `:sort`, `:select`), so the caller can skip them.
    static #operator(sql: Sql, field: string, op: string, value: any, idField: string): string {
        const id = ident(this.#real(field, idField))
        switch (op) {
            case 'eq': return `${id} = ${sql.param(value)}`
            case 'ne': return `${id} IS DISTINCT FROM ${sql.param(value)}`
            case 'lt': return `${id} < ${sql.param(this.#number(value))}`
            case 'lte': return `${id} <= ${sql.param(this.#number(value))}`
            case 'gt': return `${id} > ${sql.param(this.#number(value))}`
            case 'gte': return `${id} >= ${sql.param(this.#number(value))}`
            case 'in': return `${id} = ANY(${sql.param(this.#parse_array(value))})`
            case 'nin': return `(${id} <> ALL(${sql.param(this.#parse_array(value))}) OR ${id} IS NULL)`
            case 'eq-number': return `${id} = ${sql.param(this.#number(value))}`
            case 'neq-number': return `${id} IS DISTINCT FROM ${sql.param(this.#number(value))}`
            case 'eq-boolean': return `${id} = ${sql.param(this.#bool(value))}`
            case 'neq-boolean': return `${id} IS DISTINCT FROM ${sql.param(this.#bool(value))}`
            case 'eq-null': return `${id} IS NULL`
            case 'neq-null': return `${id} IS NOT NULL`
            // Postgres has no ObjectId; treat the mongo `-oid` suffixes as plain equality
            // so clients written against the mongo adapter keep working with uuid/text ids.
            case 'eq-oid': return `${id} = ${sql.param(value)}`
            case 'neq-oid': return `${id} IS DISTINCT FROM ${sql.param(value)}`
            default: return ''
        }
    }

    // Recursively translate Livequery filter conditions into a SQL boolean expression.
    // `joiner` is how the direct field predicates of THIS level combine (AND for normal
    // groups, OR inside a `:or` block). `:and` / `:or` / `:not` recurse with their own
    // joiner and are parenthesized into the parent.
    static #build_group<T extends LivequeryBaseEntity>(
        sql: Sql,
        filters: FilterConditions<T> | undefined,
        idField: string,
        joiner: 'AND' | 'OR' = 'AND'
    ): string {
        if (!filters) return ''
        const { ':and': and, ':or': or, ':not': not, ...rest } = filters as Record<string, any>

        const predicates: string[] = []
        const likes: string[] = []

        for (const [k, v] of Object.entries(rest)) {
            if (k.startsWith('::')) continue
            if (k.endsWith(':sort')) continue
            if (k.endsWith(':select')) continue
            if (k.endsWith(':like')) {
                const field = k.slice(0, -':like'.length)
                likes.push(`${ident(this.#real(field, idField))} ILIKE ${sql.param('%' + escapeLike(`${v}`) + '%')}`)
                continue
            }
            const idx = k.indexOf(':')
            const field = idx === -1 ? k : k.slice(0, idx)
            const op = idx === -1 ? 'eq' : k.slice(idx + 1)
            const clause = this.#operator(sql, field, op, v, idField)
            if (clause) predicates.push(clause)
        }

        // Multiple `:like` clauses are OR'd together (matching the mongo adapter), then
        // AND'd into the surrounding group.
        if (likes.length > 0) predicates.push(likes.length === 1 ? likes[0] : `(${likes.join(' OR ')})`)

        const andSql = this.#build_group(sql, and, idField, 'AND')
        if (andSql) predicates.push(`(${andSql})`)

        const orSql = this.#build_group(sql, or, idField, 'OR')
        if (orSql) predicates.push(`(${orSql})`)

        const notSql = this.#build_group(sql, not, idField, 'AND')
        if (notSql) predicates.push(`NOT (${notSql})`)

        return predicates.join(` ${joiner} `)
    }

    // The non-control filter keys, with request keys merged in (so route params and
    // dynamic keys filter the same way mongo merges `req.keys`).
    static #filter_input<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>): Record<string, any> {
        const {
            ':after': _a, ':before': _b, ':around': _ar,
            ':limit': _l, ':page': _p, ':search': _s,
            ...rest
        } = req.query || {}
        return { ...rest, ...req.keys }
    }

    // Build the full base WHERE (filters + keys + free-text search) for a fresh Sql.
    static #base_where<T extends LivequeryBaseEntity>(sql: Sql, req: LivequeryRequest<T>, table: PostgresTable): string {
        const clauses: string[] = []
        const filter = this.#build_group(sql, this.#filter_input(req) as any, table.idField, 'AND')
        if (filter) clauses.push(filter)

        const search = req.query?.[':search']
        if (search && table.searchFields?.length) {
            const term = sql.param('%' + escapeLike(`${search}`) + '%')
            const ors = table.searchFields.map(f => `${ident(f)}::text ILIKE ${term}`)
            clauses.push(`(${ors.join(' OR ')})`)
        }

        return clauses.length === 0 ? '' : clauses.join(' AND ')
    }

    // --- Sorting ---

    static #sort<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>): SortColumn[] {
        let idDir: 'ASC' | 'DESC' = 'DESC'
        const out: SortColumn[] = []

        for (const [k, order] of Object.entries(req.query || {})) {
            if (!k.endsWith(':sort')) continue
            const by = k.slice(0, -':sort'.length)
            if (by == 'id') {
                idDir = (order == 'asc' || order == '1' || order == 1) ? 'ASC' : 'DESC'
                continue
            }
            out.push({ key: by, dir: order == 'asc' ? 'ASC' : 'DESC' })
        }

        // `id` is always the final tiebreaker so the cursor keyset is total/stable.
        out.push({ key: 'id', dir: idDir })
        return out
    }

    static #order_by(sort: SortColumn[], idField: string, reverse = false): string {
        return sort
            .map(({ key, dir }) => {
                const d = reverse ? (dir === 'ASC' ? 'DESC' : 'ASC') : dir
                return `${ident(this.#real(key, idField))} ${d}`
            })
            .join(', ')
    }

    // --- Keyset (cursor) ---

    // Lexicographic row comparison expanded into OR-of-AND form so it works with mixed
    // sort directions (Postgres row-value `>` only handles uniform direction).
    // `side='after'` → rows that sort strictly after the cursor; `'before'` → strictly
    // before. Earlier sort columns are pinned with `=`, the pivot column uses `</>`.
    static #keyset(sql: Sql, sort: SortColumn[], cursor: Record<string, any>, side: 'after' | 'before', idField: string): string {
        const clauses: string[] = []
        for (let i = 0; i < sort.length; i++) {
            const conj: string[] = []
            for (let j = 0; j < i; j++) {
                const col = ident(this.#real(sort[j].key, idField))
                conj.push(`${col} = ${sql.param(cursor[sort[j].key])}`)
            }
            const { key, dir } = sort[i]
            const col = ident(this.#real(key, idField))
            const ascending = dir === 'ASC'
            const op = side === 'after' ? (ascending ? '>' : '<') : (ascending ? '<' : '>')
            conj.push(`${col} ${op} ${sql.param(cursor[key])}`)
            clauses.push(`(${conj.join(' AND ')})`)
        }
        return clauses.length ? `(${clauses.join(' OR ')})` : ''
    }

    static #where(...clauses: string[]): string {
        const parts = clauses.filter(Boolean)
        return parts.length ? `WHERE ${parts.map(p => `(${p})`).join(' AND ')}` : ''
    }

    static #map_rows(rows: any[], idField: string): any[] {
        if (idField === 'id') return rows
        return rows.map(row => {
            const { [idField]: pk, ...rest } = row
            return { id: pk, ...rest }
        })
    }

    // --- Summary (::name aggregates) ---

    static async #summary<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, table: PostgresTable): Promise<Record<string, any>> {
        const entries = Object.entries(req.query || {}).filter(([k]) => k.startsWith('::'))
        if (entries.length === 0) return {}

        const summary: Record<string, any> = {}

        for (const [rawKey, rawValue] of entries) {
            const key = rawKey.slice(2)
            const exprs = `${rawValue}`.split('|').filter(Boolean)

            const aggregates: Array<{ alias: string, sql: string }> = []
            for (const expr of exprs) {
                const fn = expr.split('(')[0]
                if (!['sum', 'avg', 'max', 'min', 'count', 'distinct'].includes(fn)) continue
                if (fn === 'count' || fn === 'distinct') {
                    aggregates.push({ alias: fn, sql: 'count(*)::int' })
                    continue
                }
                const inner = expr.split('(')?.[1]?.split(')')?.[0]
                if (!inner) continue
                const alias = `${fn}_${inner}`
                const arithmetic = this.#postfix_to_sql(this.#infix_to_postfix(inner))
                // sum/avg over `numeric` come back as strings from node-postgres; cast to
                // float8 so the summary value is a JS number (parity with the mongo adapter).
                // min/max are type-preserving and left alone.
                const cast = fn === 'sum' || fn === 'avg' ? '::float8' : ''
                aggregates.push({ alias, sql: `${fn}(${arithmetic})${cast}` })
            }

            const groups = exprs.filter(g => g.match(/^[a-zA-Z_]+$/))
            const isDistinct = `${rawValue}`.includes('distinc')

            // Optional inline match: `field==v`, `field>=v`, ... applied on top of the base filter.
            const sql = new Sql()
            const baseWhere = this.#base_where(sql, req, table)
            const matchClauses: string[] = []
            for (const expr of exprs) {
                for (const { c, op } of [
                    { c: '==', op: '=' }, { c: '<>', op: '<>' }, { c: '>=', op: '>=' },
                    { c: '<=', op: '<=' }, { c: '>', op: '>' }, { c: '<', op: '<' }, { c: '=', op: '=' },
                ]) {
                    if (expr.includes(c)) {
                        const [a, b] = expr.split(c)
                        const value = isNaN(Number(b)) ? (c == '==' ? b == 'true' : b) : Number(b)
                        matchClauses.push(`${ident(a)} ${op} ${sql.param(value)}`)
                        break
                    }
                }
            }

            const where = this.#where(baseWhere, ...matchClauses)
            const groupCols = groups.map(g => ident(g))

            if (isDistinct) {
                // count of distinct group-key combinations.
                const text = `SELECT count(*)::int AS ${ident(key)} FROM (SELECT 1 FROM ${table.name} ${where}${groupCols.length ? ` GROUP BY ${groupCols.join(', ')}` : ''}) t`
                const rows = await exec(table.db, text, sql.values)
                summary[key] = rows[0]?.[key] ?? 0
                continue
            }

            const select = [
                ...groups.map(g => `${ident(g)} AS ${ident(g)}`),
                ...aggregates.map(a => `${a.sql} AS ${ident(a.alias)}`),
            ].join(', ') || '1'

            const grouped = groupCols.length > 0
            const text = `SELECT ${select} FROM ${table.name} ${where}`
                + (grouped ? ` GROUP BY ${groupCols.join(', ')}` : '')
                + (grouped ? ` LIMIT 50` : '')

            const rows = await exec(table.db, text, sql.values)

            // Single aggregate, no grouping -> expose the scalar directly (matches mongo).
            const simple = !grouped && exprs.length === 1 && aggregates.length === 1
            summary[key] = simple ? (rows[0]?.[aggregates[0].alias] ?? null) : rows
        }

        return summary
    }

    // --- Entry point ---

    static async query<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, table: PostgresTable): Promise<PostgresReadResult<T>> {
        const idField = table.idField

        // Document read: match by keys, return the single row.
        if (!req.is_collection) {
            const sql = new Sql()
            const keyClauses = Object.entries(req.keys || {}).map(
                ([k, v]) => `${ident(this.#real(k, idField))} = ${sql.param(v)}`
            )
            const where = this.#where(keyClauses.join(' AND '))
            const text = `SELECT * FROM ${table.name} ${where} LIMIT 1`
            const rows = this.#map_rows(await exec(table.db, text, sql.values), idField)
            return {
                items: rows as T[],
                limit: 1,
                count: { next: 0, prev: 0 },
                has: { next: false, prev: false },
                summary: {},
            }
        }

        const limit = this.#get_limit(req)
        const sort = this.#sort(req)
        const after = req.query?.[':after']
        const before = req.query?.[':before']
        const around = req.query?.[':around']
        const page = req.query?.[':page']

        const summary = await this.#summary(req, table)

        // Offset paging (only when `:page` is set and no cursor token is present).
        if (page && !after && !before && !around) {
            const pageNum = Math.max(1, Math.floor(Number(page)) || 1)
            const skip = (pageNum - 1) * limit

            const itemsSql = new Sql()
            const itemsWhere = this.#base_where(itemsSql, req, table)
            const itemsText = `SELECT * FROM ${table.name} ${this.#where(itemsWhere)} ORDER BY ${this.#order_by(sort, idField)} LIMIT ${limit} OFFSET ${skip}`
            const items = this.#map_rows(await exec(table.db, itemsText, itemsSql.values), idField)

            const countSql = new Sql()
            const countWhere = this.#base_where(countSql, req, table)
            const countText = `SELECT count(*)::int AS total FROM ${table.name} ${this.#where(countWhere)}`
            const total = (await exec(table.db, countText, countSql.values))[0]?.total ?? 0

            return {
                items: items as T[],
                limit,
                count: { prev: skip, next: Math.max(total - skip - limit, 0) },
                has: { prev: skip > 0, next: total > skip + limit },
                summary,
            }
        }

        // Cursor paging.
        let items: any[]

        if (around) {
            const cursor = this.#parse_cursor(around)
            const half = Math.floor(limit / 2)

            const beforeSql = new Sql()
            const beforeBase = this.#base_where(beforeSql, req, table)
            const beforeKeyset = this.#keyset(beforeSql, sort, cursor, 'before', idField)
            const beforeText = `SELECT * FROM ${table.name} ${this.#where(beforeBase, beforeKeyset)} ORDER BY ${this.#order_by(sort, idField, true)} LIMIT ${half}`
            const beforeRows = (await exec(table.db, beforeText, beforeSql.values)).reverse()

            const need = limit - beforeRows.length
            const afterSql = new Sql()
            const afterBase = this.#base_where(afterSql, req, table)
            // Inclusive of the cursor row so the anchor item is part of the window.
            const afterKeyset = this.#keyset(afterSql, sort, cursor, 'after', idField)
            const eq = sort.map(s => `${ident(this.#real(s.key, idField))} = ${afterSql.param(cursor[s.key])}`).join(' AND ')
            const afterText = `SELECT * FROM ${table.name} ${this.#where(afterBase, `(${afterKeyset} OR (${eq}))`)} ORDER BY ${this.#order_by(sort, idField)} LIMIT ${need}`
            const afterRows = await exec(table.db, afterText, afterSql.values)

            items = this.#map_rows([...beforeRows, ...afterRows], idField)
        } else if (before) {
            const cursor = this.#parse_cursor(before)
            const sql = new Sql()
            const base = this.#base_where(sql, req, table)
            const keyset = this.#keyset(sql, sort, cursor, 'before', idField)
            // Closest `limit` rows before the cursor: fetch reversed, then flip back.
            const text = `SELECT * FROM ${table.name} ${this.#where(base, keyset)} ORDER BY ${this.#order_by(sort, idField, true)} LIMIT ${limit}`
            items = this.#map_rows((await exec(table.db, text, sql.values)).reverse(), idField)
        } else {
            const sql = new Sql()
            const base = this.#base_where(sql, req, table)
            const keyset = after ? this.#keyset(sql, sort, this.#parse_cursor(after), 'after', idField) : ''
            const text = `SELECT * FROM ${table.name} ${this.#where(base, keyset)} ORDER BY ${this.#order_by(sort, idField)} LIMIT ${limit}`
            items = this.#map_rows(await exec(table.db, text, sql.values), idField)
        }

        // Count rows before the first / after the last item of the window, within the filter.
        let prev = 0
        let next = 0
        if (items.length > 0) {
            const first = items[0]
            const last = items[items.length - 1]
            const sql = new Sql()
            const base = this.#base_where(sql, req, table)
            const beforeFirst = this.#keyset(sql, sort, this.#cursor_of(first, sort), 'before', idField)
            const afterLast = this.#keyset(sql, sort, this.#cursor_of(last, sort), 'after', idField)
            const text = `SELECT`
                + ` count(*) FILTER (WHERE ${beforeFirst || 'false'})::int AS prev,`
                + ` count(*) FILTER (WHERE ${afterLast || 'false'})::int AS next`
                + ` FROM ${table.name} ${this.#where(base)}`
            const row = (await exec(table.db, text, sql.values))[0]
            prev = row?.prev ?? 0
            next = row?.next ?? 0
        }

        return {
            items: items as T[],
            limit,
            count: { prev, next },
            has: { prev: prev > 0, next: next > 0 },
            summary,
        }
    }

    // Extract the keyset values (by public field name) from a result row.
    static #cursor_of(row: any, sort: SortColumn[]): Record<string, any> {
        return sort.reduce((p, { key }) => ({ ...p, [key]: row[key] }), {} as Record<string, any>)
    }
}
