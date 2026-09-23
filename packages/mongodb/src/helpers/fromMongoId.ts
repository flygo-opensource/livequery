import { Binary, ObjectId } from 'mongodb'

/**
 * The public `id` string for an `_id`: ObjectId → 24 hex, BSON UUID → dashed uuid. Anything
 * else (a string `_id` written by hand, a number) goes through `String()` as before.
 *
 * `String(binary)` would NOT do: Binary stringifies its raw bytes, not the uuid.
 */
export function fromMongoId(value: unknown): string {
    if (value instanceof ObjectId) return value.toHexString()
    if (value instanceof Binary && value.sub_type === Binary.SUBTYPE_UUID) return value.toUUID().toHexString(true)
    return String(value)
}
