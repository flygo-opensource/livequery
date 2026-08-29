// Live realtime test: exercises PostgresRealtime (LISTEN/NOTIFY) against a REAL server.
//   DATABASE_URL='postgres://user:pass@host:5432/db' bun tests/live-realtime.ts
//
// Covers: trigger install, added/modified/removed, nested refs (users/:user_id/posts),
// array fan-out (editors/:editor_ids/posts), and automatic reconnect after the listening
// connection is force-terminated.

import { Client, Pool } from 'pg'
import { PostgresRealtime, type PostgresRealtimeRoute } from '../src/PostgresRealtime.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pool = new Pool({ connectionString: url })

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: any) {
    if (cond) { passed++; console.log(`  ✓ ${name}`) }
    else { failed++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

const events: any[] = []
async function waitFor(pred: (e: any) => boolean, ms = 5000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
        const found = events.find(pred)
        if (found) return found
        await sleep(100)
    }
    return undefined
}

async function main() {
    // --- schema + triggers ---
    await pool.query('DROP TABLE IF EXISTS products')
    await pool.query('DROP TABLE IF EXISTS posts')
    await pool.query(`CREATE TABLE products (id text PRIMARY KEY, name text, price numeric)`)
    await pool.query(`CREATE TABLE posts (id text PRIMARY KEY, user_id text, editor_ids text[], title text)`)
    await pool.query(PostgresRealtime.triggerSql(['products', 'posts'], 'livequery'))
    console.log('triggers installed')

    const routes: PostgresRealtimeRoute[] = [
        { schema: 'products', options: { table: 'products', realtime: true } },
        { schema: 'users/:user_id/posts', options: { table: 'posts', realtime: true } },
        { schema: 'editors/:editor_ids/posts', options: { table: 'posts', realtime: true } },
    ]

    // --- subscribe via a FACTORY so reconnect creates a fresh client each time ---
    let factoryCalls = 0
    const factory = async () => {
        const c = new Client({ connectionString: url, application_name: 'lq-realtime' })
        await c.connect()
        factoryCalls++
        return c as any
    }

    const rt = new PostgresRealtime({ channel: 'livequery', reconnectDelayMs: 300, maxReconnectDelayMs: 2000 })
    const sub = rt.watch(factory, routes).subscribe(e => events.push(e))
    await sleep(800) // let LISTEN register
    check('factory opened one connection', factoryCalls === 1, factoryCalls)

    // --- added / modified / removed on products ---
    console.log('\n[added / modified / removed]')
    await pool.query(`INSERT INTO products (id, name, price) VALUES ('1', 'iPhone', 999)`)
    const added = await waitFor(e => e.ref === 'products' && e.type === 'added' && e.data?.id === '1')
    check('INSERT -> added with full row', !!added && added.data.name === 'iPhone' && Number(added.data.price) === 999, added?.data)

    await pool.query(`UPDATE products SET price = 899 WHERE id = '1'`)
    const modified = await waitFor(e => e.ref === 'products' && e.type === 'modified' && e.data?.id === '1')
    check('UPDATE -> modified with changed field only', !!modified && Number(modified.data.price) === 899 && modified.data.name === undefined, modified?.data)

    await pool.query(`DELETE FROM products WHERE id = '1'`)
    const removed = await waitFor(e => e.ref === 'products' && e.type === 'removed' && e.data?.id === '1')
    check('DELETE -> removed', !!removed, removed?.data)

    // --- nested ref + array fan-out on posts ---
    console.log('\n[nested ref + array fan-out]')
    await pool.query(`INSERT INTO posts (id, user_id, editor_ids, title) VALUES ('p1', 'u1', ARRAY['e1','e2'], 'Hello')`)
    const nested = await waitFor(e => e.ref === 'users/u1/posts' && e.type === 'added' && e.data?.id === 'p1')
    check('nested ref users/u1/posts', !!nested && nested.data.title === 'Hello', nested?.ref)
    const fan1 = await waitFor(e => e.ref === 'editors/e1/posts' && e.type === 'added')
    const fan2 = await waitFor(e => e.ref === 'editors/e2/posts' && e.type === 'added')
    check('array fan-out editors/e1/posts + editors/e2/posts', !!fan1 && !!fan2, [fan1?.ref, fan2?.ref])

    // --- auto-reconnect after the listening connection is terminated ---
    console.log('\n[auto-reconnect]')
    const before = events.length
    const killed = await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'lq-realtime' AND pid <> pg_backend_pid()`
    )
    console.log(`  terminated ${killed.rowCount} listener backend(s)`)
    // Wait for the retry to build a second connection.
    const reconnected = await (async () => {
        const start = Date.now()
        while (Date.now() - start < 8000) { if (factoryCalls >= 2) return true; await sleep(150) }
        return false
    })()
    check('factory called again (reconnected)', reconnected, factoryCalls)
    await sleep(500) // let the new LISTEN register

    await pool.query(`INSERT INTO products (id, name, price) VALUES ('2', 'Pixel', 799)`)
    const afterReconnect = await waitFor(e => e.ref === 'products' && e.type === 'added' && e.data?.id === '2')
    check('event received after reconnect', !!afterReconnect && events.length > before, afterReconnect?.data)

    sub.unsubscribe()
    console.log(`\n=== ${passed} passed, ${failed} failed ===`)
}

main()
    .catch(e => { console.error('FATAL', e); failed++ })
    .finally(async () => { await pool.end(); await sleep(200); process.exit(failed ? 1 : 0) })
