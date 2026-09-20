import type { IncomingMessage } from 'http'
import type { OutgoingHttpHeaders } from 'http2'
import { Readable } from 'stream'

export function nodeRequestToWebRequest(
    req: IncomingMessage & { url: string; method: string; rawBody?: Buffer },
    extraHeaders?: OutgoingHttpHeaders
): Request {
    const host = req.headers.host ?? '127.0.0.1'
    const headers = new Headers(req.headers as HeadersInit)
    if (extraHeaders) {
        new Headers(extraHeaders as HeadersInit).forEach((value, key) => headers.set(key, value))
    }

    const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : req.rawBody
            ? new Uint8Array(req.rawBody)
            // Nothing buffered the body (plain http.createServer): stream it instead of dropping it.
            // Node's web-stream type is runtime-compatible with fetch but not with the DOM lib type.
            : typeof req.on === 'function' ? Readable.toWeb(req) as unknown as BodyInit : undefined

    return new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers,
        body,
        duplex: body ? 'half' : undefined,
    } as RequestInit)
}
