import { ObjectId, UUID } from 'mongodb'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i

/**
 * The `_id` value for a public `id` string. Documents created by the server have an ObjectId;
 * documents created with a client id (uuidv7) store it as a BSON UUID. The two formats cannot be
 * confused: a uuid has dashes, an ObjectId is 24 hex characters.
 *
 * Throws 400 `INVALID_OBJECT_ID` (the historical code) naming the field for anything else.
 */
export function toMongoId(field: string, value: unknown): ObjectId | UUID {
    if (typeof value === 'string' && UUID_PATTERN.test(value)) return new UUID(value)
    if (typeof value === 'string' && OBJECT_ID_PATTERN.test(value)) return ObjectId.createFromHexString(value)
    throw { status: 400, code: 'INVALID_OBJECT_ID', message: `Invalid id for field "${field}": ${JSON.stringify(value)}` }
}
