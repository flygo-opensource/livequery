/**
 * E2E: LivequeryClient + RestTransporter + MemoryStorage
 *   → Hono (livequery middleware) → MongoDatasource → real MongoDB
 *   → realtime via MongodbRealtime (wired through createDatasourceMapper's watcher).
 *
 * Same matrix as the NestJS variant (helpers/client-suite.ts) — proves the client
 * stack is backend-adapter agnostic. Uses useDatasource's native bare responses
 * (wrapData: false) to exercise RestTransporter's no-envelope fallback.
 */

import { defineClientFullstackSuite } from './helpers/client-suite.js'
import { buildHonoMongoApp } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'

defineClientFullstackSuite('Hono', () => buildHonoMongoApp({
    collection: uniqueCollection('client_hono'),
    ref: 'tasks',
    realtime: true,
    wrapData: false,
}))
