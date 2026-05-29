import * as http from 'http'
import * as net from 'net'
import type { AddressInfo } from 'net'

export function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer()
        s.listen(0, () => {
            const port = (s.address() as AddressInfo).port
            s.close(() => resolve(port))
        })
        s.on('error', reject)
    })
}

export function startHttpServer(
    handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler ?? ((_req, res) => { res.writeHead(200); res.end('{}') }))
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

export function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
        // Force-close any lingering keep-alive / WS connections so the server
        // shuts down immediately instead of waiting for them to idle out.
        try { (server as any).closeAllConnections?.() } catch { /* Bun may not have this */ }
        server.close(() => resolve())
    })
}

export function wsConnect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url)
        ws.addEventListener('open', () => resolve(ws))
        ws.addEventListener('error', (e) => reject(e))
    })
}

export function waitForWsMessage<T = any>(
    ws: WebSocket,
    predicate: (msg: T) => boolean,
    timeout = 4000
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
            } catch { /* ignore parse errors */ }
        }

        ws.addEventListener('message', handler as any)
    })
}

export function sendJson(ws: WebSocket, data: unknown) {
    ws.send(JSON.stringify(data))
}

export function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms))
}

export async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url, init)
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
}
