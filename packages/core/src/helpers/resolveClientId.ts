const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * How far in the future a client id's timestamp may be. uuidv7 embeds the creation time in ms, and
 * ids sort by it; a clock set years ahead would pin a document to the end of every `id` sort.
 * Generous on purpose: a write rejected here is rejected for good, and phones drift.
 */
export const CLIENT_ID_MAX_FUTURE_MS = 24 * 60 * 60 * 1000

/** Code of the 409 a datasource throws when an add reuses an id that already exists. */
export const ID_ALREADY_EXISTS = 'ID_ALREADY_EXISTS'

/**
 * The id a client asked a new document to have, validated.
 *
 * Clients generate ids (uuidv7) so an add that is retried after a lost response cannot create a
 * second document: the retry reuses the id and the database rejects the duplicate.
 *
 * - no `id`, or a legacy optimistic `local:…` id (clients before 3.0 sent those) → `undefined`,
 *   and the datasource assigns the id as it always did;
 * - a uuidv7 whose timestamp is not more than a day ahead → that id, lower-cased;
 * - anything else → throws 400 `INVALID_ID`.
 */
export function resolveClientId(body: unknown, now = Date.now()): string | undefined {
    if (typeof body !== 'object' || body === null) return undefined
    const id = (body as Record<string, unknown>).id
    if (id === undefined || id === null) return undefined
    if (typeof id === 'string' && id.startsWith('local:')) return undefined

    if (typeof id !== 'string' || !UUID_V7.test(id)) {
        throw { status: 400, code: 'INVALID_ID', message: `id must be a uuidv7, got ${JSON.stringify(id)}` }
    }
    const timestamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    if (timestamp > now + CLIENT_ID_MAX_FUTURE_MS) {
        throw { status: 400, code: 'INVALID_ID', message: `id ${id} is timestamped in the future (${new Date(timestamp).toISOString()})` }
    }
    return id.toLowerCase()
}
