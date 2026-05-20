import { IncomingMessage } from "http";
import { OutgoingHttpHeaders } from "http2";

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
        : req.rawBody ? new Uint8Array(req.rawBody) : undefined

    return new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers,
        body,
        duplex: body ? 'half' : undefined,
    } as RequestInit)
}
