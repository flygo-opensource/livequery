import * as http from 'http'

export function wsConnect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url)
        ws.addEventListener('open', () => resolve(ws))
        ws.addEventListener('error', e => reject(e))
    })
}

export function sendJson(ws: WebSocket, data: unknown) {
    ws.send(JSON.stringify(data))
}

export function waitForWsMessage<T = any>(
    ws: WebSocket,
    predicate: (msg: T) => boolean,
    timeout = 6000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener('message', handler as any)
            reject(new Error('Timeout waiting for WS message'))
        }, timeout)

        function handler(event: MessageEvent) {
            try {
                const data = JSON.parse(event.data) as T
                if (predicate(data)) {
                    clearTimeout(timer)
                    ws.removeEventListener('message', handler as any)
                    resolve(data)
                }
            } catch { /* ignore non-JSON frames */ }
        }

        ws.addEventListener('message', handler as any)
    })
}

/** Connect a raw WS client and complete the start/hello handshake. */
export async function wsStart(url: string, clientId: string): Promise<{ ws: WebSocket, gatewayId: string }> {
    const ws = await wsConnect(url)
    sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
    const hello = await waitForWsMessage<{ event: string, gid: string }>(ws, m => m.event === 'hello')
    return { ws, gatewayId: hello.gid }
}

export function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        try { (server as any).closeAllConnections?.() } catch { /* not available everywhere */ }
        server.close(() => resolve())
    })
}

export async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number, body: any }> {
    const res = await fetch(url, init)
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
}
