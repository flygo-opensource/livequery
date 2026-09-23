/**
 * In-process Hono server backed by a Map — no MongoDB. The write routes run `validator()` with a
 * `z.strictObject` schema, the setup the shipped examples recommend, so any unknown key in a write
 * body (a client-side `id: "local:..."`, say) is answered with 400 exactly like production.
 *
 * `stop()` / `start()` take the server down and bring it back on the same port, so tests can drive
 * a real `NETWORK_ERROR` and a real recovery.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { validator } from '../../packages/honojs/src/validator.js'

export type MemoryTask = {
    id: string
    title: string
    done: boolean
}

export type MemoryServerRequest = {
    method: string
    path: string
    body?: unknown
}

const Task = z.strictObject({
    title: z.string(),
    done: z.boolean(),
})

export async function createMemoryServer() {
    const tasks = new Map<string, MemoryTask>()
    const requests: MemoryServerRequest[] = []
    let next_id = 1

    const app = new Hono()

    app.use('*', async (c, next) => {
        const body = ['POST', 'PATCH'].includes(c.req.method)
            ? await c.req.raw.clone().json().catch(() => undefined)
            : undefined
        requests.push({ method: c.req.method, path: new URL(c.req.url).pathname, body })
        await next()
    })

    app.get('/livequery/tasks', c => {
        const items = [...tasks.values()]
        return c.json({
            data: {
                items,
                count: { current: items.length, total: items.length, prev: 0, next: 0 },
                has: { prev: false, next: false },
                cursor: {},
            },
        })
    })

    app.get('/livequery/tasks/:id', c => {
        const item = tasks.get(c.req.param('id'))
        if (!item) return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found' } }, 404)
        return c.json({ data: { item } })
    })

    app.post('/livequery/tasks', validator(Task), async c => {
        const body = await c.req.json()
        const item = { ...body, id: `srv-${next_id++}` } as MemoryTask
        tasks.set(item.id, item)
        return c.json({ data: item })
    })

    app.patch('/livequery/tasks/:id', validator(Task), async c => {
        const id = c.req.param('id')
        const current = tasks.get(id)
        if (!current) return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found' } }, 404)
        const item = { ...current, ...await c.req.json() }
        tasks.set(id, item)
        return c.json({ data: item })
    })

    app.delete('/livequery/tasks/:id', c => {
        const id = c.req.param('id')
        const current = tasks.get(id)
        if (!current) return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found' } }, 404)
        tasks.delete(id)
        return c.json({ data: current })
    })

    let server = Bun.serve({ port: 0, fetch: app.fetch })
    const port = server.port

    return {
        port,
        apiUrl: `http://127.0.0.1:${port}/livequery`,
        tasks,
        requests,
        writes: () => requests.filter(r => r.method !== 'GET'),
        async stop() {
            await server.stop(true)
        },
        start() {
            server = Bun.serve({ port, fetch: app.fetch })
        },
        async close() {
            await server.stop(true)
        },
    }
}
