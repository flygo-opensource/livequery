import type { DocError } from '../types.js'

const RETRYABLE_CODES = new Set(['NETWORK_ERROR', 'AbortError', 'TimeoutError'])
const RETRYABLE_HTTP_CODE = /^HTTP_(5\d\d|408|429)$/

/**
 * Whether a failed write may succeed if sent again unchanged: the network, a timeout, or the
 * server being unwell. A 4xx is the request's own fault (validation, permission) and retrying it
 * would fail forever.
 */
export function isRetryableError(error: DocError) {
    if (typeof error.status === 'number') return error.status >= 500 || error.status === 408 || error.status === 429
    return RETRYABLE_CODES.has(error.code) || RETRYABLE_HTTP_CODE.test(error.code)
}
