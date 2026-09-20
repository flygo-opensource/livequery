import { afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

type Runtime = 'node' | 'bun'

type ManagedProcess = {
    process: ReturnType<typeof Bun.spawn>
    output: string[]
}

type Frame = { event: string; gid?: string; data?: { changes: Array<{ type: string; data: { id: string } }> } }

const processes: ManagedProcess[] = []

afterEach(async () => {
    await Promise.all(processes.splice(0).map(async managed => {
        managed.process.kill('SIGTERM')
        await managed.process.exited
    }))
})

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── scenarios ─────────────────────────────────────────────────────────────────

describe('API gateway + service examples', () => {
    for (const gateway_runtime of ['node', 'bun'] as const) {
        for (const service_runtime of ['node', 'bun'] as const) {
            test(`${gateway_runtime} gateway + ${service_runtime} service — CRUD and realtime through the gateway`,
                async () => {
                    const ports = makePorts()
                    const gateway = start(gateway_runtime, 'gateway.ts', ports)
                    await waitForLine(gateway, '"event":"ready"')
                    const service = start(service_runtime, 'service.ts', ports)
                    await waitForLine(service, '"event":"ready"')

                    const base = `http://127.0.0.1:${ports.GATEWAY_PORT}`
                    await waitForRoute(`${base}/livequery/tasks`)
                    // Give the gateway a moment to open its WebSocket link to the service.
                    await tick(500)

                    const ws_url = `ws://127.0.0.1:${ports.GATEWAY_PORT}/livequery/realtime-updates`
                    const client = await connectClient(ws_url)
                    const headers = { 'x-lcid': client.id, 'x-lgid': client.gateway_id }

                    const list = await fetch(`${base}/livequery/tasks`, { headers })
                    expect(list.status).toBe(200)
                    expect(await list.json()).toEqual({ items: [] })

                    const created = await fetch(`${base}/livequery/tasks`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ title: 'Write docs' }),
                    })
                    expect(created.status).toBe(201)
                    const { item } = await created.json() as { item: { id: string } }
                    expect(await client.nextChange()).toMatchObject({ type: 'added', data: { id: item.id } })

                    const updated = await fetch(`${base}/livequery/tasks/${item.id}`, {
                        method: 'PATCH',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ status: 'done' }),
                    })
                    expect(await updated.json()).toMatchObject({ item: { id: item.id, status: 'done' } })
                    expect(await client.nextChange()).toMatchObject({ type: 'modified', data: { id: item.id } })

                    const invalid = await fetch(`${base}/livequery/tasks`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ status: 'done' }),
                    })
                    expect(invalid.status).toBe(400)

                    const removed = await fetch(`${base}/livequery/tasks/${item.id}`, { method: 'DELETE' })
                    expect(removed.status).toBe(200)
                    expect(await client.nextChange()).toMatchObject({ type: 'removed', data: { id: item.id } })

                    const missing = await fetch(`${base}/livequery/tasks/${item.id}`)
                    expect(missing.status).toBe(404)

                    const preflight = await fetch(`${base}/livequery/tasks`, { method: 'OPTIONS' })
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
        OHAYO_DISCOVERY_PORT: String(base + 2),
        // Unique namespace and key per test so parallel runs never see each other's services.
        OHAYO_DISCOVERY_NAMESPACE: `e2e-${base}`,
        OHAYO_DISCOVERY_KEY: `e2e-key-${base}`,
    }
}

function start(runtime: Runtime, filename: string, environment: Record<string, string>): ManagedProcess {
    const script = fileURLToPath(new URL(`${runtime}/${filename}`, import.meta.url))
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

    const next = async (predicate: (frame: Frame) => boolean, timeout_ms = 3_000) => {
        const deadline = Date.now() + timeout_ms
        while (Date.now() < deadline) {
            const index = frames.findIndex(predicate)
            if (index !== -1) return frames.splice(index, 1)[0]
            await tick(20)
        }
        throw new Error(`No matching frame; received ${JSON.stringify(frames)}`)
    }

    const hello = await next(frame => frame.event === 'hello')
    return {
        id,
        gateway_id: hello.gid as string,
        nextChange: async () => (await next(frame => frame.event === 'sync')).data?.changes[0],
        close: () => ws.close(),
    }
}
