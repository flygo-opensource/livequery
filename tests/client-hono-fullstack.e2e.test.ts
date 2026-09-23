/**
 * E2E: LivequeryClient + RestTransporter + MemoryStorage
 *   → Hono (livequery middleware) → MongoDatasource → real MongoDB
 *   → realtime via MongodbRealtime (wired through createDatasourceMapper's watcher).
 *
 * Same matrix as the NestJS variant (helpers/client-suite.ts) — proves the client
 * stack is backend-adapter agnostic. Uses useDatasource's native bare responses
 * (wrapData: false) to exercise RestTransporter's no-envelope fallback. Writes go through
 * `validator()` with a `z.strictObject`, like the shipped examples: a client that sends `id` or
 * any other unknown key in a write body fails the add/update tests with 400 VALIDATION_FAILED.
 */

import { z } from 'zod'

import { defineClientFullstackSuite } from './helpers/client-suite.js'
import { buildHonoMongoApp } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'

defineClientFullstackSuite('Hono', () => buildHonoMongoApp({
    collection: uniqueCollection('client_hono'),
    ref: 'tasks',
    realtime: true,
    wrapData: false,
    schema: z.strictObject({
        title: z.string(),
        done: z.boolean(),
        seq: z.number(),
    }),
}))
