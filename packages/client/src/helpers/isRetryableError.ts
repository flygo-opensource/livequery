import type { DocError } from '../types.js'

const RETRYABLE_CODES = new Set(['NETWORK_ERROR', 'AbortError', 'TimeoutError', 'UNAUTHORIZED', 'UNAUTHENTICATED'])
const RETRYABLE_HTTP_CODE = /^HTTP_(5\d\d|401|408|429)$/

/**
 * Whether a failed write may succeed if sent again unchanged: the network, a timeout, the server
 * being unwell — or an expired login (401). A write queued offline is often replayed hours later,
 * after the token expired; dropping it then would lose the user's work. The queue waits instead,
 * and the transporter reads the refreshed token when it retries.
 *
 * Other 4xx (validation, permission, not found) are the request's own fault and would fail forever.
 */
export function isRetryableError(error: DocError) {
    if (typeof error.status === 'number') {
        return error.status >= 500 || error.status === 401 || error.status === 408 || error.status === 429
    }
    return RETRYABLE_CODES.has(error.code) || RETRYABLE_HTTP_CODE.test(error.code)
}
