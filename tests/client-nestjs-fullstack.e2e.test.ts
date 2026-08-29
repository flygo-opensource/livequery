/**
 * E2E: LivequeryClient + RestTransporter + MemoryStorage
 *   → NestJS (LivequeryInterceptor) → MongoDatasource → real MongoDB
 *   → realtime via MongodbRealtime change streams back into collection state.
 *
 * The shared suite lives in helpers/client-suite.ts — the Hono variant runs the
 * exact same matrix.
 */

import { defineClientFullstackSuite } from './helpers/client-suite.js'
import { buildNestMongoApp } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'

defineClientFullstackSuite('NestJS', () => buildNestMongoApp({
    collection: uniqueCollection('client_nest'),
    ref: 'tasks',
    realtime: true,
}))
