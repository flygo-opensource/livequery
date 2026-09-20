import type { Env } from './types.js'

const ANONYMOUS = 'anonymous'

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Compares hex digests of equal length without an early exit.
function digestsEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

function readToken(request: Request): string | undefined {
    const header = request.headers.get('Authorization')
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined
    // Browsers cannot set headers on a WebSocket upgrade, so the realtime URL carries the token.
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return new URL(request.url).searchParams.get('token') ?? undefined
    }
    return undefined
}

/**
 * Resolve the caller's principal, or undefined when the request is not authenticated.
 * The principal is derived from the token hash, so it never exposes the token itself.
 */
export async function authenticate(request: Request, env: Env): Promise<string | undefined> {
    const token = readToken(request)
    if (!token) return env.ALLOW_ANONYMOUS === 'true' ? ANONYMOUS : undefined

    const digest = await sha256(token)
    const allowed = (env.API_TOKENS ?? '').split(',').map(t => t.trim()).filter(Boolean)
    let matched = false
    for (const candidate of allowed) {
        if (digestsEqual(await sha256(candidate), digest)) matched = true
    }
    return matched ? `token:${digest.slice(0, 32)}` : undefined
}
