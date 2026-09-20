/**
 * E2E for the todo example, against a real MongoDB replica set.
 *
 *   bun test todo-mongodb/e2e.test.ts
 *
 * Point it elsewhere with LIVEQUERY_E2E_MONGO_URL. Runs the same file on Node and on Bun.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'

type Runtime = 'node' | 'bun'
type Managed = { process: ReturnType<typeof Bun.spawn>; output: string[] }
type Frame = { event: string; gid?: string; data?: { changes: Array<{ ref: string; type: string; data: { id: string; title?: string } }> } }

const MONGO_URL = process.env.LIVEQUERY_E2E_MONGO_URL
    ?? 'mongodb://127.0.0.1:27017/?authSource=admin'
const DB_NAME = process.env.LIVEQUERY_E2E_DB_NAME ?? 'livequery'

// Both runtimes must be able to open a TCP connection to the server. On a Mac that has not
// granted a runtime the Local Network permission, every LAN address answers EHOSTUNREACH — the
// leg is skipped with that reason rather than reported as a broken example.
const reachable = Object.fromEntries(await Promise.all((['node', 'bun'] as const)
    .map(async runtime => [runtime, await canReach(runtime, MONGO_URL)] as const)))

const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 15_000 })
const db = client.db(DB_NAME)
const processes: Managed[] = []

afterEach(async () => {
    await Promise.all(processes.splice(0).map(async managed => {
        managed.process.kill('SIGTERM')
        await managed.process.exited
    }))
})

afterAll(() => client.close().catch(() => undefined))

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('todo-mongodb example', () => {
    for (const runtime of ['node', 'bun'] as const) {
        test.skipIf(!reachable[runtime])(`${runtime} — CRUD, and realtime straight from the change stream`, async () => {
            const port = 21_000 + Math.floor(Math.random() * 10_000)
            const collection_name = `todos_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
            await client.connect()
            const collection = db.collection(collection_name)

            const server = start(runtime, { PORT: String(port), COLLECTION: collection_name, MONGO_URL, DB_NAME })
            await waitForLine(server, '"kind":"todo-mongodb"')
            const base = `http://127.0.0.1:${port}`
            await waitForRoute(`${base}/health`)

            try {
                const todo_client = await connectClient(`ws://127.0.0.1:${port}/livequery/realtime-updates`)
                const headers = { 'x-lcid': todo_client.id, 'x-lgid': todo_client.gateway_id }
                const json = { ...headers, 'content-type': 'application/json' }

                const list = await fetch(`${base}/livequery/todos`, { headers })
                expect(list.status).toBe(200)
                expect(await list.json()).toMatchObject({ items: [] })

                // The change stream opens asynchronously; a write only shows up once it is live.
                await waitForStream(collection, todo_client)

                const created = await fetch(`${base}/livequery/todos`, {
                    method: 'POST', headers: json, body: JSON.stringify({ title: 'Write the example' }),
                })
                expect(created.status).toBe(201)
                const { item } = await created.json() as { item: { id: string; done: boolean } }
                expect(item.done).toBe(false)                     // schema default applied

                const patched = await fetch(`${base}/livequery/todos/${item.id}`, {
                    method: 'PATCH', headers: json, body: JSON.stringify({ done: true }),
                })
                expect(patched.status).toBe(200)

                const read = await fetch(`${base}/livequery/todos/${item.id}`, { headers })
                expect(await read.json()).toMatchObject({ item: { id: item.id, done: true } })

                // A write nobody routed through the API: this is what the change stream buys.
                const out_of_band = await collection.insertOne({ title: 'Inserted by mongosh', done: false })

                const removed = await fetch(`${base}/livequery/todos/${item.id}`, { method: 'DELETE', headers })
                expect(removed.status).toBe(200)

                expect(await todo_client.changes(4)).toEqual([
                    `todos:added:${item.id}`,
                    `todos:modified:${item.id}`,
                    `todos:added:${out_of_band.insertedId.toString()}`,
                    `todos:removed:${item.id}`,
                ])

                const bad_body = await fetch(`${base}/livequery/todos`, {
                    method: 'POST', headers: json, body: JSON.stringify({ title: '' }),
                })
                expect(bad_body.status).toBe(400)

                const unknown_field = await fetch(`${base}/livequery/todos`, {
                    method: 'POST', headers: json, body: JSON.stringify({ title: 'x', is_admin: true }),
                })
                expect(unknown_field.status).toBe(400)

                // The schema is also the allowlist of fields a client may filter on.
                const unknown_filter = await fetch(`${base}/livequery/todos?is_admin=1`, { headers })
                expect(unknown_filter.status).toBe(400)
                expect(await unknown_filter.json()).toMatchObject({ error: { code: 'FIELD_NOT_ALLOWED' } })

                const filtered = await fetch(`${base}/livequery/todos?done:eq-boolean=false&title:sort=asc`, { headers })
                expect(filtered.status).toBe(200)
                expect(await filtered.json()).toMatchObject({ items: [{ title: 'Inserted by mongosh' }] })

                const missing = await fetch(`${base}/livequery/unknown`, { headers })
                expect(missing.status).toBe(404)

                const preflight = await fetch(`${base}/livequery/todos`, {
                    method: 'OPTIONS',
                    headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST' },
                })
                expect(preflight.headers.get('access-control-allow-headers')).toContain('x-lgid')

                const page = await fetch(base)
                expect(page.status).toBe(200)
                expect(await page.text()).toContain('realtime-updates')

                todo_client.close()
            } finally {
                await collection.drop().catch(() => undefined)
            }
        }, 60_000)
    }
})

// ─── helpers ───────────────────────────────────────────────────────────────────

async function canReach(runtime: Runtime, url: string): Promise<boolean> {
    const { hostname, port } = new URL(url.replace(/^mongodb(\+srv)?:/, 'http:'))
    const probe = `const s = require('node:net').connect({ host: ${JSON.stringify(hostname)}, `
        + `port: ${Number(port) || 27017} }, () => { console.log('ok'); s.destroy() });`
        + `s.setTimeout(5000, () => s.destroy()); s.on('error', e => console.log('no:', e.message))`
    const child = Bun.spawn([runtime, '-e', probe], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stdout).text()
    await child.exited
    if (output.startsWith('ok')) return true
    console.warn(`todo-mongodb e2e: skipping the ${runtime} leg, it cannot reach ${hostname}:${port} — ${output.trim()}`)
    return false
}

function start(runtime: Runtime, environment: Record<string, string>): Managed {
    const script = fileURLToPath(new URL('index.ts', import.meta.url))
    const child = Bun.spawn([runtime, script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const managed: Managed = { process: child, output: [] }
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

async function waitForLine(managed: Managed, text: string, timeout_ms = 30_000) {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
        if (managed.output.some(line => line.includes(text))) return
        await tick(50)
    }
    throw new Error(`Timed out waiting for ${text}. Output:\n${managed.output.join('\n')}`)
}

async function waitForRoute(url: string, timeout_ms = 30_000) {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
        const response = await fetch(url).catch(() => undefined)
        if (response?.status === 200) return
        await tick(100)
    }
    throw new Error(`Never answered: ${url}`)
}

/** Insert throwaway documents until one comes back over the socket, then forget them. */
async function waitForStream(
    collection: { insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }>; deleteOne(filter: Record<string, unknown>): Promise<unknown> },
    client: Awaited<ReturnType<typeof connectClient>>,
    timeout_ms = 30_000,
) {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
        const { insertedId } = await collection.insertOne({ title: '__warmup__', done: false })
        const id = String(insertedId)
        for (let i = 0; i < 20; i++) {
            if (client.seen().some(change => change.includes(id))) {
                await collection.deleteOne({ _id: insertedId as never })
                await tick(200)
                client.reset()
                return
            }
            await tick(100)
        }
        await collection.deleteOne({ _id: insertedId as never })
    }
    throw new Error('Change stream never delivered a warmup document')
}

async function connectClient(url: string) {
    const id = crypto.randomUUID()
    const ws = new WebSocket(url)
    let frames: Frame[] = []
    ws.onmessage = event => frames.push(JSON.parse(String(event.data)))
    await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = reject
    })
    ws.send(JSON.stringify({ event: 'start', data: { id } }))

    const hello = await (async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
            const found = frames.find(frame => frame.event === 'hello')
            if (found) return found
            await tick(20)
        }
        throw new Error('No hello frame')
    })()

    const seen = () => frames
        .filter(frame => frame.event === 'sync')
        .flatMap(frame => frame.data?.changes ?? [])
        .map(change => `${change.ref}:${change.type}:${change.data.id}`)

    return {
        id,
        gateway_id: hello.gid as string,
        seen,
        reset: () => { frames = [] },
        /** Waits for `count` changes and returns them as `ref:type:id`. */
        async changes(count: number, timeout_ms = 15_000) {
            const deadline = Date.now() + timeout_ms
            while (Date.now() < deadline && seen().length < count) await tick(25)
            return seen()
        },
        close: () => ws.close(),
    }
}
