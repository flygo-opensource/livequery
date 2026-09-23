import { afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

type Runtime = 'node' | 'bun'

type ManagedProcess = {
    process: ReturnType<typeof Bun.spawn>
    output: string[]
}

type Frame = { event: string; gid?: string; data?: { changes: Array<{ ref: string; type: string; data: { id: string } }> } }

const processes: ManagedProcess[] = []

afterEach(async () => {
    await Promise.all(processes.splice(0).map(async managed => {
        managed.process.kill('SIGTERM')
        await managed.process.exited
    }))
})

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── scenarios ─────────────────────────────────────────────────────────────────

describe('API gateway + service example', () => {
    for (const discovery of [false, true]) for (const gateway_runtime of ['node', 'bun'] as const) {
        for (const service_runtime of ['node', 'bun'] as const) {
            test(`${gateway_runtime} gateway + ${service_runtime} service${discovery ? ' found over UDP' : ''} — CRUD and realtime through the gateway`,
                async () => {
                    const ports = {
                        ...makePorts(),
                        // The service announces itself; the gateway never reads SERVICE_URL. A key
                        // and port of its own keep the test off any real discovery on the network.
                        ...discovery ? {
                            DISCOVERY: 'udp',
                            SIMPLE_DISCOVERY_KEY: `e2e-${crypto.randomUUID()}`,
                            SIMPLE_DISCOVERY_PORT: String(30_000 + Math.floor(Math.random() * 20_000)),
                        } : {},
                    }
                    const gateway = start(gateway_runtime, 'gateway.ts', ports)
                    await waitForLine(gateway, '"kind":"gateway"')
                    const service = start(service_runtime, 'service.ts', ports)
                    await waitForLine(service, '"kind":"service"')

                    const base = `http://127.0.0.1:${ports.GATEWAY_PORT}`
                    await waitForRoute(`${base}/livequery/tasks`)

                    const client = await connectClient(`ws://127.0.0.1:${ports.GATEWAY_PORT}/livequery/realtime-updates`)
                    const headers = { 'x-lcid': client.id, 'x-lgid': client.gateway_id }
                    const json = { ...headers, 'content-type': 'application/json' }

                    const list = await fetch(`${base}/livequery/tasks`, { headers })
                    expect(list.status).toBe(200)
                    expect(await list.json()).toEqual({ items: [] })
                    // The gateway consumes the service's realtime headers and never forwards them.
                    expect(list.headers.get('x-livequery-ref')).toBeNull()

                    const created = await fetch(`${base}/livequery/tasks`, {
                        method: 'POST',
                        headers: json,
                        body: JSON.stringify({ title: 'Write docs' }),
                    })
                    expect(created.status).toBe(201)
                    const { item } = await created.json() as { item: { id: string; status: string } }
                    expect(item.status).toBe('todo')          // schema default applied

                    const updated = await fetch(`${base}/livequery/tasks/${item.id}`, {
                        method: 'PATCH',
                        headers: json,
                        body: JSON.stringify({ status: 'done' }),
                    })
                    expect(await updated.json()).toMatchObject({ item: { id: item.id, status: 'done' } })

                    const removed = await fetch(`${base}/livequery/tasks/${item.id}`, { method: 'DELETE', headers })
                    expect(removed.status).toBe(200)

                    expect(await client.changes(3)).toEqual([
                        `tasks:added:${item.id}`,
                        `tasks:modified:${item.id}`,
                        `tasks:removed:${item.id}`,
                    ])

                    const invalid = await fetch(`${base}/livequery/tasks`, {
                        method: 'POST',
                        headers: json,
                        body: JSON.stringify({ status: 'done' }),     // title is required
                    })
                    expect(invalid.status).toBe(400)

                    const unknown_field = await fetch(`${base}/livequery/tasks`, {
                        method: 'POST',
                        headers: json,
                        body: JSON.stringify({ title: 'x', is_admin: true }),
                    })
                    expect(unknown_field.status).toBe(400)

                    const missing = await fetch(`${base}/livequery/tasks/${item.id}`, { headers })
                    expect(missing.status).toBe(404)

                    const unowned = await fetch(`${base}/livequery/unknown`, { headers })
                    expect(unowned.status).toBe(404)

                    const preflight = await fetch(`${base}/livequery/tasks`, {
                        method: 'OPTIONS',
                        headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST' },
                    })
                    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-lgid')

                    client.close()
                },
                20_000,
            )
        }
    }
})

// ─── helpers ───────────────────────────────────────────────────────────────────

function makePorts() {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    return {
        GATEWAY_PORT: String(base),
        SERVICE_PORT: String(base + 1),
        SERVICE_URL: `http://127.0.0.1:${base + 1}`,
    }
}

function start(runtime: Runtime, filename: string, environment: Record<string, string>): ManagedProcess {
    const script = fileURLToPath(new URL(filename, import.meta.url))
    const child = Bun.spawn([runtime, script], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const managed: ManagedProcess = { process: child, output: [] }
    processes.push(managed)
    for (const stream of [child.stdout, child.stderr]) void readLines(stream, line => managed.output.push(line))
    return managed
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) onLine(line)
    }
}

async function waitForLine(managed: ManagedProcess, text: string, timeout_ms = 10_000) {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
        if (managed.output.some(line => line.includes(text))) return
        await tick(50)
    }
    throw new Error(`Timed out waiting for ${text}. Output:\n${managed.output.join('\n')}`)
}

async function waitForRoute(url: string, timeout_ms = 10_000) {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
        const response = await fetch(url).catch(() => undefined)
        if (response?.status === 200) return
        await tick(100)
    }
    throw new Error(`Gateway never routed ${url}`)
}

async function connectClient(url: string) {
    const id = crypto.randomUUID()
    const ws = new WebSocket(url)
    const frames: Frame[] = []
    ws.onmessage = event => frames.push(JSON.parse(String(event.data)))
    await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = reject
    })
    ws.send(JSON.stringify({ event: 'start', data: { id } }))

    const hello = await (async () => {
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline) {
            const found = frames.find(frame => frame.event === 'hello')
            if (found) return found
            await tick(20)
        }
        throw new Error('No hello frame')
    })()

    return {
        id,
        gateway_id: hello.gid as string,
        /** Waits for `count` changes and returns them as `ref:type:id`. */
        async changes(count: number, timeout_ms = 5_000) {
            const deadline = Date.now() + timeout_ms
            const seen = () => frames
                .filter(frame => frame.event === 'sync')
                .flatMap(frame => frame.data?.changes ?? [])
                .map(change => `${change.ref}:${change.type}:${change.data.id}`)
            while (Date.now() < deadline && seen().length < count) await tick(25)
            return seen()
        },
        close: () => ws.close(),
    }
}
