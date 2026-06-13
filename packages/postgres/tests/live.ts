// Live integration test: drives PostgresDatasource against a REAL PostgreSQL server
// (no mocks). Run with:
//   DATABASE_URL='postgres://user:pass@host:5432/db' bun tests/live.ts
//
// It creates a `products` table, then exercises the adapter end to end: insert, filter,
// sort, document read, $inc patch, summary, cursor pagination, and delete.

import { Pool } from 'pg'
import { PostgresDatasource } from '../src/PostgresDatasource.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const pool = new Pool({ connectionString: url })

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: any) {
    if (cond) { passed++; console.log(`  ✓ ${name}`) }
    else { failed++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

async function main() {
    const v = await pool.query('SELECT version()')
    console.log('Connected:', v.rows[0].version.split(',')[0])

    await pool.query('DROP TABLE IF EXISTS products')
    await pool.query(`CREATE TABLE products (
        id text PRIMARY KEY,
        name text,
        price numeric,
        category text,
        stock int,
        active boolean
    )`)

    const ds = new PostgresDatasource({ connections: { default: pool } })
    await ds.init([
        { method: 'GET', path: '/products', table: 'products', searchFields: ['name', 'category'] },
        { method: 'GET', path: '/products/:id', table: 'products' },
    ])

    const q = (over: any) => ds.query({ method: 'get', ref: 'products', is_collection: true, keys: {}, query: {}, ...over } as any, { table: 'products', searchFields: ['name', 'category'] })

    // --- POST (real INSERT ... RETURNING *) ---
    console.log('\n[insert]')
    const seed = [
        { id: '1', name: 'iPhone', price: 999, category: 'phone', stock: 5, active: true },
        { id: '2', name: 'Pixel', price: 799, category: 'phone', stock: 8, active: false },
        { id: '3', name: 'MacBook', price: 1999, category: 'laptop', stock: 3, active: true },
        { id: '4', name: 'ThinkPad', price: 1499, category: 'laptop', stock: 10, active: true },
        { id: '5', name: 'iPad', price: 599, category: 'tablet', stock: 7, active: false },
    ]
    for (const row of seed) {
        const r: any = await ds.query({ method: 'post', ref: 'products', is_collection: true, keys: {}, body: row } as any, { table: 'products' })
        check(`insert ${row.id} returns row`, r.item?.id === row.id && r.item?.name === row.name, r.item)
    }

    // --- Filter + sort + limit ---
    console.log('\n[filter + sort + limit]')
    const r1: any = await q({ query: { 'price:gte': 800, 'price:sort': 'asc', ':limit': 10 } })
    const ids1 = r1.items.map((x: any) => x.id)
    // Pixel (799) is excluded; iPhone 999, ThinkPad 1499, MacBook 1999 sorted asc.
    check('price>=800 sorted asc by price', JSON.stringify(ids1) === JSON.stringify(['1', '4', '3']), ids1)
    check('count.total = 3', r1.count.total === 3, r1.count)

    // --- :like + :search ---
    console.log('\n[like + search]')
    const r2: any = await q({ query: { 'name:like': 'i', 'id:sort': 'asc' } })
    // ILIKE %i% matches iPhone, Pixel, ThinkPad, iPad (not MacBook).
    check('name:like "i" (case-insensitive, excludes MacBook)', JSON.stringify(r2.items.map((x: any) => x.id)) === JSON.stringify(['1', '2', '4', '5']), r2.items.map((x: any) => x.name))
    const r3: any = await q({ query: { ':search': 'pad', 'id:sort': 'asc' } })
    // searchFields=['name']: matches iPad and ThinkPad.
    check(':search "pad" -> ThinkPad, iPad', JSON.stringify(r3.items.map((x: any) => x.id)) === JSON.stringify(['4', '5']), r3.items.map((x: any) => x.name))

    // --- :in ---
    console.log('\n[in]')
    const r4: any = await q({ query: { 'category:in': '["laptop","tablet"]', 'id:sort': 'asc' } })
    check('category in [laptop,tablet]', JSON.stringify(r4.items.map((x: any) => x.id)) === JSON.stringify(['3', '4', '5']), r4.items.map((x: any) => x.id))

    // --- Document read ---
    console.log('\n[document read]')
    const d1: any = await ds.query({ method: 'get', ref: 'products/:id', is_collection: false, document_id: '3', keys: { id: '3' }, query: {} } as any, { table: 'products' })
    check('GET /products/3 -> MacBook', d1.item?.name === 'MacBook', d1.item)

    // --- PATCH $inc ---
    console.log('\n[patch $inc]')
    await ds.query({ method: 'patch', ref: 'products/:id', is_collection: false, document_id: '1', keys: { id: '1' }, body: { $inc: { stock: 10 } } } as any, { table: 'products' })
    const d2 = await pool.query('SELECT stock FROM products WHERE id = $1', ['1'])
    check('stock 5 + 10 = 15', Number(d2.rows[0].stock) === 15, d2.rows[0].stock)

    // --- Summary ---
    console.log('\n[summary]')
    const s1: any = await q({ query: { '::total': 'sum(price)' } })
    check('sum(price) scalar = 5895', Number(s1.summary.total) === 999 + 799 + 1999 + 1499 + 599, s1.summary.total)
    const s2: any = await q({ query: { '::byCat': 'category|count()', 'id:sort': 'asc' } })
    const byCat = Object.fromEntries((s2.summary.byCat as any[]).map(r => [r.category, Number(r.count)]))
    check('count() grouped by category', byCat.phone === 2 && byCat.laptop === 2 && byCat.tablet === 1, byCat)

    // --- Cursor pagination ---
    console.log('\n[cursor pagination]')
    const p1: any = await q({ query: { 'price:sort': 'asc', ':limit': 2 } })
    check('page1 cheapest two = iPad, Pixel', JSON.stringify(p1.items.map((x: any) => x.id)) === JSON.stringify(['5', '2']), p1.items.map((x: any) => x.id))
    check('page1 has.next', p1.has.next === true, p1.has)
    const p2: any = await q({ query: { 'price:sort': 'asc', ':limit': 2, ':after': p1.cursor.last } })
    check('page2 next two = iPhone, ThinkPad', JSON.stringify(p2.items.map((x: any) => x.id)) === JSON.stringify(['1', '4']), p2.items.map((x: any) => x.id))
    check('page2 has.prev', p2.has.prev === true, p2.has)
    check('page2 count.prev = 2', p2.count.prev === 2, p2.count)

    // --- Offset pagination ---
    console.log('\n[offset pagination]')
    const o1: any = await q({ query: { 'price:sort': 'asc', ':limit': 2, ':page': 2 } })
    check('offset page2 = iPhone, ThinkPad', JSON.stringify(o1.items.map((x: any) => x.id)) === JSON.stringify(['1', '4']), o1.items.map((x: any) => x.id))
    check('offset page.current = 2', o1.page.current === 2, o1.page)

    // --- ne / nin / boolean ---
    console.log('\n[ne / nin / boolean]')
    const n1: any = await q({ query: { 'category:ne': 'phone', 'id:sort': 'asc' } })
    check('category != phone', JSON.stringify(n1.items.map((x: any) => x.id)) === JSON.stringify(['3', '4', '5']), n1.items.map((x: any) => x.id))
    const n2: any = await q({ query: { 'id:nin': '["1","2","3"]', 'id:sort': 'asc' } })
    check('id nin [1,2,3]', JSON.stringify(n2.items.map((x: any) => x.id)) === JSON.stringify(['4', '5']), n2.items.map((x: any) => x.id))
    const b1: any = await q({ query: { 'active:eq-boolean': 'true', 'id:sort': 'asc' } })
    check('active = true', JSON.stringify(b1.items.map((x: any) => x.id)) === JSON.stringify(['1', '3', '4']), b1.items.map((x: any) => x.id))

    // --- multi-field :search ---
    console.log('\n[multi-field search]')
    const ms: any = await q({ query: { ':search': 'phone', 'id:sort': 'asc' } })
    // 'phone' matches category=phone (ids 1,2) via the category searchField (name has no "phone").
    check(':search "phone" across name+category', JSON.stringify(ms.items.map((x: any) => x.id)) === JSON.stringify(['1', '2']), ms.items.map((x: any) => x.id))

    // --- avg / max / min / distinct ---
    console.log('\n[avg / max / min / distinct]')
    const a1: any = await q({ query: { '::avg': 'avg(price)' } })
    check('avg(price) is a JS number ~1179', typeof a1.summary.avg === 'number' && Math.round(a1.summary.avg) === 1179, a1.summary.avg)
    const a2: any = await q({ query: { '::mx': 'max(price)' } })
    check('max(price) = 1999', Number(a2.summary.mx) === 1999, a2.summary.mx)
    const a3: any = await q({ query: { '::mn': 'min(price)' } })
    check('min(price) = 599', Number(a3.summary.mn) === 599, a3.summary.mn)
    const a4: any = await q({ query: { '::cats': 'category|distinct()' } })
    check('distinct categories = 3', Number(a4.summary.cats) === 3, a4.summary.cats)

    // --- before / around cursor ---
    console.log('\n[before / around cursor]')
    // Full asc-by-price order: iPad(5,599) Pixel(2,799) iPhone(1,999) ThinkPad(4,1499) MacBook(3,1999)
    const f1: any = await q({ query: { 'price:sort': 'asc', ':limit': 2 } })          // [5,2]
    const f2: any = await q({ query: { 'price:sort': 'asc', ':limit': 2, ':after': f1.cursor.last } })  // [1,4]
    const back: any = await q({ query: { 'price:sort': 'asc', ':limit': 2, ':before': f2.cursor.first } })
    check(':before page1.first -> previous page [5,2]', JSON.stringify(back.items.map((x: any) => x.id)) === JSON.stringify(['5', '2']), back.items.map((x: any) => x.id))
    check(':before has.next', back.has.next === true, back.has)
    const ar: any = await q({ query: { 'price:sort': 'asc', ':limit': 3, ':around': f2.cursor.first } })
    // centered on iPhone(1): one before (Pixel 2) + iPhone(1) + one after (ThinkPad 4)
    check(':around centers the cursor row', JSON.stringify(ar.items.map((x: any) => x.id)) === JSON.stringify(['2', '1', '4']), ar.items.map((x: any) => x.id))

    // --- numeric column note: pg returns numeric as string in item rows ---
    console.log('\n[numeric representation]')
    check('numeric price is a string in rows (node-postgres default)', typeof f1.items[0].price === 'string', typeof f1.items[0].price)

    // --- DELETE ---
    console.log('\n[delete]')
    const del: any = await ds.query({ method: 'delete', ref: 'products/:id', is_collection: false, document_id: '5', keys: { id: '5' } } as any, { table: 'products' })
    check('delete returns deleted row', del.item?.id === '5', del.item)
    const after = await pool.query('SELECT count(*)::int AS c FROM products')
    check('4 rows remain', after.rows[0].c === 4, after.rows[0].c)

    console.log(`\n=== ${passed} passed, ${failed} failed ===`)
}

main()
    .catch(e => { console.error('FATAL', e); failed++ })
    .finally(async () => { await pool.end(); process.exit(failed ? 1 : 0) })
