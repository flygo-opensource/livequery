/**
 * Two tabs in a real Chrome (headless, throwaway profile) against a running demo:
 * the tabs share the SharedWorker, see each other's changes online and offline, the queue drains
 * when back online, data survives a reload. Then device D, a PWA losing its network for real (its
 * browser goes through a local proxy that is switched off): the app opens offline from the service
 * worker, a todo added offline survives a reload and is sent when the network comes back.
 *
 *   bun examples/todo-offline/browser-check.ts https://livequery-demo.global.flygo.vn
 *
 * Needs Google Chrome installed (CHROME_PATH overrides the macOS default).
 */
import puppeteer from 'puppeteer-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.argv[2] ?? 'https://livequery-demo.global.flygo.vn'
const API = `${URL}/livequery/todos`
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'lq-demo-')),
    protocolTimeout: 20000,
    args: ['--no-first-run', '--no-default-browser-check'],
})

const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
    if (!ok) process.exitCode = 1
}
const titles = (page: any) => page.$$eval('.row .title', (els: any[]) => els.map(e => e.textContent))
const rowTag = (page: any, title: string) => page.$$eval('.row', (rows: any[], t: string) => {
    const row = rows.find(r => r.querySelector('.title')?.textContent === t)
    return row ? (row.querySelector('.tag')?.textContent ?? '') : null
}, title)
const waitUntil = async (fn: () => Promise<boolean>, ms = 10000) => {
    const started = Date.now()
    while (Date.now() - started < ms) {
        if (await fn()) return true
        await new Promise(r => setTimeout(r, 150))
    }
    return false
}
const serverTitles = async () => ((await (await fetch(`${API}?:limit=100&created_at:sort=desc`)).json()).items ?? []).map((i: any) => i.title)

// An HTTP CONNECT proxy with an off switch: the network of device D.
type Tunnel = { client: Bun.Socket<any>, upstream?: Bun.Socket<any> }
let network_up = true
const tunnels = new Set<Tunnel>()
const proxy = Bun.listen<Tunnel>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
        open(client) { client.data = { client } },
        async data(client, chunk) {
            const tunnel = client.data
            if (tunnel.upstream) return void tunnel.upstream.write(chunk)
            const match = /^CONNECT ([^:\s]+):(\d+)/.exec(Buffer.from(chunk).toString('latin1'))
            if (!match || !network_up) return void client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
            tunnels.add(tunnel)
            tunnel.upstream = await Bun.connect({
                hostname: match[1]!, port: Number(match[2]),
                socket: {
                    data(_upstream, data) { client.write(data) },
                    close() { client.end(); tunnels.delete(tunnel) },
                    error() { client.end(); tunnels.delete(tunnel) },
                },
            }).catch(() => undefined)
            if (!tunnel.upstream) return void client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        },
        close(client) { client.data.upstream?.end(); tunnels.delete(client.data) },
        error(client) { client.data.upstream?.end(); tunnels.delete(client.data) },
    },
})
const setNetwork = (up: boolean) => {
    network_up = up
    if (up) return
    for (const tunnel of tunnels) {
        tunnel.upstream?.terminate()
        tunnel.client.terminate()
    }
    tunnels.clear()
}

try {
    const a = await browser.newPage()
    const b = await browser.newPage()
    const errors: string[] = []
    for (const p of [a, b]) p.on('pageerror', (e: any) => errors.push(String(e)))
    // The realtime socket never idles, so wait for the app instead of the network.
    await a.goto(URL, { waitUntil: 'domcontentloaded' })
    await a.waitForSelector('.host')
    await b.goto(URL, { waitUntil: 'domcontentloaded' })
    await b.waitForSelector('.host')
    // Headless Chrome runs no animation frames in a background tab, and a click needs them.
    const act = async (page: any, fn: () => Promise<unknown>) => { await page.bringToFront(); await fn() }

    const host = await a.$eval('.host', (e: any) => e.className)
    check('tab runs on the SharedWorker', host.includes('shared-worker'), host)
    check('status shows Online', await waitUntil(async () => (await a.$eval('.status', (e: any) => e.textContent)).includes('Online')))

    // 1. online: a change in tab A appears in tab B
    const online_title = `tab-sync-${Date.now()}`
    await act(a, async () => { await a.type('.add input', online_title); await a.click('.add button') })
    check('online add in tab A shows in tab B', await waitUntil(async () => (await titles(b)).includes(online_title), 5000))
    check('…and reached the server', await waitUntil(async () => (await serverTitles()).includes(online_title)))

    // 2. offline: toggle in A is shared, a change in A shows in B before it reaches the server
    await act(a, () => a.click('.toggle input'))
    check('offline toggle is shared by both tabs', await waitUntil(async () => b.$eval('.toggle input', (e: any) => e.checked)))
    const offline_title = `offline-${Date.now()}`
    await act(a, async () => { await a.type('.add input', offline_title); await a.click('.add button') })
    check('offline add in tab A shows in tab B at once', await waitUntil(async () => (await titles(b)).includes(offline_title), 3000))
    check('tab B marks it as waiting', await waitUntil(async () => ((await rowTag(b, offline_title)) ?? '').startsWith('Chờ')), await rowTag(b, offline_title) ?? '')
    check('badge counts it in tab B', (await b.$eval('.badge', (e: any) => e.textContent)).includes('chờ đồng bộ'))
    check('the server does not have it yet', !(await serverTitles()).includes(offline_title))

    // 3. back online from tab B: the queue drains
    await act(b, () => b.click('.toggle input'))
    check('back online, the queue drains to the server', await waitUntil(async () => (await serverTitles()).includes(offline_title)))
    check('tab A shows it synced', await waitUntil(async () => (await rowTag(a, offline_title)) === ''))
    check('badge back to synced', await waitUntil(async () => (await a.$eval('.badge', (e: any) => e.textContent)) === 'Đã đồng bộ'))

    // 4. reload both tabs: data still there
    await a.bringToFront()
    await a.reload({ waitUntil: 'domcontentloaded' })
    await a.waitForSelector('.host')
    check('after reload, tab A still lists both', await waitUntil(async () => {
        const list = await titles(a)
        return list.includes(online_title) && list.includes(offline_title)
    }))

    // cleanup: delete both from tab B, gone everywhere
    await b.bringToFront()
    for (const t of [online_title, offline_title]) {
        await b.$$eval('.row', (rows: any[], title: string) => {
            rows.find(r => r.querySelector('.title')?.textContent === title)?.querySelector('.delete')?.click()
        }, t)
    }
    check('deletes from tab B disappear from tab A', await waitUntil(async () => {
        const list = await titles(a)
        return !list.includes(online_title) && !list.includes(offline_title)
    }))
    check('…and from the server', await waitUntil(async () => {
        const list = await serverTitles()
        return !list.includes(online_title) && !list.includes(offline_title)
    }))

    // ── device D: a PWA losing its network for real ──────────────────────────────────────
    const pwa = await browser.createBrowserContext({ proxyServer: `http://127.0.0.1:${proxy.port}` })
    const d = await pwa.newPage()
    d.on('pageerror', (e: any) => errors.push(String(e)))
    await d.bringToFront()
    await d.goto(URL, { waitUntil: 'domcontentloaded' })
    const kept = `pwa-kept-${Date.now()}`
    await d.waitForSelector('.add input')
    await waitUntil(async () => (await d.$eval('.status', (e: any) => e.textContent)).includes('Online'))
    await d.type('.add input', kept)
    await d.click('.add button')
    check('device D: an online todo reaches the server', await waitUntil(async () => (await serverTitles()).includes(kept)))
    check('device D: the service worker installs', await waitUntil(async () => await d.evaluate(async () => !!(await navigator.serviceWorker.ready).active), 15000))
    await d.reload({ waitUntil: 'domcontentloaded' })
    check('…and controls the page', await waitUntil(async () => await d.evaluate(() => !!navigator.serviceWorker.controller)))

    setNetwork(false)
    check('network cut: the server is unreachable from device D', await d.evaluate(async (url: string) => fetch(url).then(() => false, () => true), `${URL}/health?probe=${Date.now()}`))
    await d.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    check('offline reload: the app opens from the service worker, with its todos', await waitUntil(async () => (await titles(d).catch(() => [])).includes(kept), 15000))
    check('…and says Offline', await waitUntil(async () => (await d.$eval('.status', (e: any) => e.textContent)).includes('Offline')))
    const queued = `pwa-offline-${Date.now()}`
    await d.type('.add input', queued)
    await d.click('.add button')
    check('a todo added offline waits (Chờ thêm)', await waitUntil(async () => (await rowTag(d, queued)) === 'Chờ thêm'), String(await rowTag(d, queued)))
    await d.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    check('after another offline reload it is still there, still waiting', await waitUntil(async () => (await rowTag(d, queued)) === 'Chờ thêm', 15000), String(await rowTag(d, queued)))
    check('the server does not have it', !(await serverTitles()).includes(queued))

    setNetwork(true)
    check('network back: it is sent on its own', await waitUntil(async () => (await serverTitles()).includes(queued), 30000))
    await a.bringToFront()
    check('…and tab A (another browser) shows it', await waitUntil(async () => (await titles(a)).includes(queued)))
    check('device D shows it synced', await waitUntil(async () => { await d.bringToFront(); return (await rowTag(d, queued)) === '' }))

    // Leave the demo as it was.
    for (const title of [kept, queued]) {
        await a.bringToFront()
        await a.$$eval('.row', (rows: any[], t: string) => {
            rows.find(r => r.querySelector('.title')?.textContent === t)?.querySelector('.delete')?.click()
        }, title)
    }
    check('cleanup: removed from the server', await waitUntil(async () => {
        const list = await serverTitles()
        return !list.includes(kept) && !list.includes(queued)
    }))
    check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
    await browser.close()
    proxy.stop(true)
}
