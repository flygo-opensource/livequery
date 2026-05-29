import { Hono } from 'hono'
import {
    createLivequery,
    getLivequeryRequest,
    HonoApiServiceLinker,
    livequeryJson,
    WebsocketGateway,
} from '@livequery/honojs'
import { serveHono } from './_serve.js'

const app = new Hono()
const port = Number(process.env.PORT ?? 3001)

const server = await serveHono(app, port)
const websocketGateway = new WebsocketGateway(server.server)
const livequery = createLivequery(app, { websocketGateway })

livequery.get('/livequery/products', c => {
    return livequeryJson(c, {
        items: [
            { id: 'p-1', name: 'Keyboard', _secret: 'hidden' },
            { id: 'p-2', name: 'Mouse', _secret: 'hidden' },
        ],
    })
})

livequery.get('/livequery/products/:id', c => {
    const req = getLivequeryRequest(c)
    return livequeryJson(c, {
        item: { id: req.doc_id, name: `Product ${req.doc_id}`, _secret: 'hidden' },
    })
})

const linker = new HonoApiServiceLinker({
    routes: livequery.registry,
    websocketGateway,
})

linker.start('products-service', server.port)

console.info(`Service API listening at ${server.url}`)
console.info('Try: curl http://127.0.0.1:3001/livequery/products')
