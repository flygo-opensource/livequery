// SQLite identifiers accepted as table or column names. Anything else is rejected
// before it can reach the SQL string, because D1 cannot bind identifiers as params.
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// D1 caps a statement at 100 bound parameters; keep one IN list well below that
// so the WHERE, cursor and LIMIT params still fit.
export const MAX_IN_VALUES = 50
