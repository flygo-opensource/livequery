import { Hono } from 'hono'
import { ApiServiceLinker } from '../../src/ApiServiceLinker.js'

const kind = process.env.SERVICE_KIND
if (kind !== 'catalog' && kind !== 'orders' && kind !== 'mirror') {
    throw new Error(`Unsupported SERVICE_KIND: ${kind}`)
}

const app = new Hono()
const paths: Array<{ method: string; path: string }> = []

if (kind === 'catalog') {
    app.get('/livequery/catalog', c => c.json({
        service: 'catalog',
        runtime: 'hono',
        process_id: process.pid,
        items: ['book', 'pen'],
    }))
    paths.push({ method: 'GET', path: 'livequery/catalog' })
}

if (kind === 'orders') {
    app.get('/livequery/orders/:id', c => c.json({
        service: 'orders',
        runtime: 'hono',
        process_id: process.pid,
        id: c.req.param('id'),
        include: c.req.query('include'),
        request_id: c.req.header('x-request-id'),
    }))
    paths.push({ method: 'GET', path: 'livequery/orders/:id' })

    app.post('/livequery/orders/:id', async c => c.json({
        service: 'orders',
        runtime: 'hono',
        process_id: process.pid,
        id: c.req.param('id'),
        include: c.req.query('include'),
        body: await c.req.json(),
    }))
    paths.push({ method: 'POST', path: 'livequery/orders/:id' })
}

if (kind === 'mirror') {
    app.get('/livequery/shared', c => c.json({
        service: 'mirror',
        runtime: 'hono',
        process_id: process.pid,
    }))
    paths.push({ method: 'GET', path: 'livequery/shared' })
}

const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
})

const linker = new ApiServiceLinker({
    node_id: `${kind}-service-${process.pid}`,
    paths,
})

linker.start(`${kind}-service`, server.port)

console.log(JSON.stringify({
    event: 'ready',
    kind,
    pid: process.pid,
    port: server.port,
}))

function shutdown() {
    linker.close()
    server.stop(true)
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
