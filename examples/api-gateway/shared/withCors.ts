// The browser client sends x-lcid / x-lgid on every request, so preflight must allow them.
const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-lcid, x-lgid',
}

/** Answer CORS preflights and add CORS headers to every other response. */
export async function withCors(request: Request, next: () => Promise<Response>): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    const response = await next()
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
