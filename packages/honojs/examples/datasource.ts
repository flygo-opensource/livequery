import { Hono } from 'hono'
import type { Handler } from 'hono'
import { Subject } from 'rxjs'
import {
    createDatasourceMapper,
    createLivequery,
    type LivequeryDatasource,
    livequeryJson,
    WebsocketGateway,
} from '@livequery/honojs'
import type { LivequeryBaseEntity, LivequeryRequest, WebsocketSyncPayload } from '@livequery/types'
import { serveHono } from './_serve.js'

type Product = LivequeryBaseEntity & {
    name: string
    _secret?: string
}

type Config = {
    products: Product[]
}

type RouteOptions = {
    collection: 'products'
}

class ProductDatasource
    extends Subject<WebsocketSyncPayload<LivequeryBaseEntity>>
    implements LivequeryDatasource<Config, RouteOptions> {
    #config!: Config

    async init(config: Config): Promise<void> {
        this.#config = config
    }

    async query(query: LivequeryRequest, options: RouteOptions): Promise<{ items?: Product[]; item?: Product }> {
        const products = this.#config[options.collection]
        if (query.is_collection) return { items: products }
        return { item: products.find(product => product.id === query.doc_id) }
    }
}

const app = new Hono()
const server = await serveHono(app, Number(process.env.PORT ?? 3002))
const websocketGateway = new WebsocketGateway(server.server)
const livequery = createLivequery(app, { websocketGateway })

let productsHandler: Handler = c => livequeryJson(c, { items: [] })
let productHandler: Handler = c => livequeryJson(c, { item: {} })

livequery.get('/livequery/datasource/products', c => productsHandler(c))
livequery.get('/livequery/datasource/products/:id', c => productHandler(c))

const useDatasource = await createDatasourceMapper({
    routes: livequery.registry,
    websocketGateway,
    datasource: new ProductDatasource(),
    config: {
        products: [
            { id: 'p-1', name: 'Keyboard', _secret: 'hidden' },
            { id: 'p-2', name: 'Mouse', _secret: 'hidden' },
        ],
    },
})

productsHandler = useDatasource({ collection: 'products' })
productHandler = useDatasource({ collection: 'products' })

console.info(`Datasource example listening at ${server.url}`)
console.info('Try: curl http://127.0.0.1:3002/livequery/datasource/products')
