import { IDENTIFIER_PATTERN } from '../const.js'

/** Validate a table name before it is interpolated into SQL. */
export function assertTable(name: string): string {
    if (!IDENTIFIER_PATTERN.test(name)) {
        throw new Error(`Invalid D1 table name "${name}"`)
    }
    return name
}
