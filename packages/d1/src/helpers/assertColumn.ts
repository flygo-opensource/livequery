import { IDENTIFIER_PATTERN } from '../const.js'

/**
 * Validate a table or column name before it is interpolated into SQL.
 * When `fields` is given, the name must also be in that allowlist (`id` is always allowed).
 */
export function assertColumn(name: string, fields?: readonly string[]): string {
    if (!IDENTIFIER_PATTERN.test(name)) {
        throw { status: 400, code: 'INVALID_FIELD', message: `Field "${name}" is not a valid column name` }
    }
    if (fields && name !== 'id' && !fields.includes(name)) {
        throw { status: 400, code: 'FIELD_NOT_ALLOWED', message: `Field "${name}" is not allowed` }
    }
    return name
}
