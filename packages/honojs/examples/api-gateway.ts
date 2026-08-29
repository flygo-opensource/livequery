import { Hono } from 'hono'
import {
    HonoApiGatewayLinker,
    WebsocketGateway,
} from '@livequery/honojs'
import { serveHono } from './_serve.js'

const app = new Hono()
const port = Number(process.env.PORT ?? 3000)

const server = await serveHono(app, port)
const websocketGateway = new WebsocketGateway(server.server)
const gateway = new HonoApiGatewayLinker({ websocketGateway })

app.all('*', gateway.handler())

console.info(`API gateway listening at ${server.url}`)
console.info('Start service-api.ts, then try:')
console.info('curl http://127.0.0.1:3000/livequery/products')
