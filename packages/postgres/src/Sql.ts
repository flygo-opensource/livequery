// Minimal `node-postgres`-compatible query interface. Anything that exposes a
// parameterized `query(text, values)` returning `{ rows }` works here — a `pg.Pool`,
// a `pg.Client`, or a pooled wrapper from another library. We deliberately do NOT
// import from `pg` so the build has no hard dependency on `@types/pg`.
export interface PgQueryable {
    query(text: string, values?: any[]): Promise<{ rows: any[], rowCount?: number | null }>
}

export type PostgresConnection = PgQueryable

// Accumulates positional parameters ($1, $2, ...) for a single SQL statement.
// Values are always bound, never interpolated, so user input cannot break out of
// a literal. Identifiers (column/table names) are quoted + validated separately.
export class Sql {
    readonly values: any[] = []

    param(value: any): string {
        this.values.push(value)
        return `$${this.values.length}`
    }
}

// Quote a SQL identifier, validating each segment against a strict pattern so a
// crafted column name cannot inject SQL. A dotted name (`meta.color`) is treated as
// a JSONB path: the first segment is the column, the rest a `#>>` text path, e.g.
// `"meta"#>>'{a,b}'`. Throws a 400 (not a 500) naming the bad field.
export function ident(name: string): string {
    const parts = String(name).split('.')
    for (const part of parts) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
            throw { status: 400, code: 'INVALID_FIELD', message: `Invalid field name "${name}"` }
        }
    }
    const [column, ...path] = parts
    if (path.length === 0) return `"${column}"`
    return `"${column}"#>>'{${path.join(',')}}'`
}

// Quote a schema-qualified table name: `"public"."users"`.
export function qualifiedTable(schema: string, table: string): string {
    return `${ident(schema)}.${ident(table)}`
}

// Escape LIKE/ILIKE wildcards so user input is matched literally (Postgres uses
// backslash as the default LIKE escape character).
export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&')
}

export async function exec(db: PgQueryable, text: string, values: any[] = []): Promise<any[]> {
    const result = await db.query(text, values)
    return result.rows
}
