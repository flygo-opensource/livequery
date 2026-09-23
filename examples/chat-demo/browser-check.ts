/**
 * A real Chrome (headless, throwaway profile) against a running chat demo:
 *   tab A — mike, and tab B — bob, in the same profile: one SharedWorker, one storage;
 *   device C — bob in a separate browser context: its own worker and storage, like another
 *   computer, so what reaches it went through the server;
 *   device D — alice, as an installed PWA losing its network for real: its browser goes through a
 *   local proxy that, switched off, drops every connection and refuses new ones — the page, its
 *   SharedWorker and its service worker all lose the network, as with Wi-Fi off. It reloads, reads,
 *   writes, reloads again and reconnects.
 *
 *   bun examples/chat-demo/browser-check.ts https://livequery-chat.global.flygo.vn
 *
 * Needs Google Chrome (CHROME_PATH overrides the macOS default). Writes a few test messages and a
 * test account; the ids are printed at the end for cleanup.
 */
import puppeteer, { type Page } from 'puppeteer-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.argv[2] ?? 'http://localhost:8091'

// An HTTP CONNECT proxy with an off switch: the network of device D.
type Tunnel = { client: Bun.Socket<any>, upstream?: Bun.Socket<any>, pending: Uint8Array[] }
let network_up = true
const tunnels = new Set<Tunnel>()
const proxy = Bun.listen<Tunnel>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
        open(client) { client.data = { client, pending: [] } },
        async data(client, chunk) {
            const tunnel = client.data
            if (tunnel.upstream) return void tunnel.upstream.write(chunk)
            const head = Buffer.from(chunk).toString('latin1')
            const match = /^CONNECT ([^:\s]+):(\d+)/.exec(head)
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
const API = `${URL}/livequery`
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    protocolTimeout: 30000,
    userDataDir: mkdtempSync(join(tmpdir(), 'lq-chat-')),
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=900,1000'],
})

const check = (label: string, ok: boolean, detail = '') => {
    console.log(new Date().toISOString().slice(14, 23), `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
    if (!ok) process.exitCode = 1
}
const waitUntil = async (fn: () => Promise<boolean>, ms = 10000) => {
    const started = Date.now()
    while (Date.now() - started < ms) {
        if (await fn().catch(() => false)) return true
        await new Promise(r => setTimeout(r, 150))
    }
    return false
}
const api = async (path: string) => (await (await fetch(`${API}/${path}`)).json()) as any
// Headless Chrome runs no animation frames (clicks, IntersectionObserver) in a background tab.
const front = (page: Page) => page.bringToFront()
const clickText = (page: Page, selector: string, text: string) => page.$$eval(selector, (els, t) => {
    const el = els.find(e => e.textContent?.trim().includes(t as string)) as HTMLElement | undefined
    el?.click()
    return !!el
}, text)
const bubbles = (page: Page) => page.$$eval('.bubble-row', rows => rows.map(r => ({
    text: r.querySelector('.bubble-text')?.textContent ?? '',
    delivery: r.querySelector('.delivery')?.textContent ?? '',
    failed: !!r.querySelector('.failed-actions'),
})))
const bubble = async (page: Page, text: string) => (await bubbles(page)).find(b => b.text === text)
const send = async (page: Page, text: string) => {
    await front(page)
    await page.type('.composer textarea', text)
    await page.keyboard.press('Enter')
}
const setOnline = async (page: Page, online: boolean) => {
    await front(page)
    const current = await page.$eval('.switch input', e => (e as HTMLInputElement).checked)
    if (current !== online) await page.click('.switch')
}

try {
    const a = await browser.newPage()
    const b = await browser.newPage()
    const device = await browser.createBrowserContext()
    const c = await device.newPage()
    const errors: string[] = []
    for (const p of [a, b, c]) p.on('pageerror', e => errors.push(String(e)))

    // ── accounts ────────────────────────────────────────────────────────────────────────────
    await front(a)
    await a.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
    check('accounts page lists the seeded accounts', await waitUntil(async () => {
        const names = await a.$$eval('.account span', els => els.map(e => e.textContent))
        return ['mike', 'bob', 'alice'].every(n => names.includes(n))
    }))
    check('the tab runs on the SharedWorker', (await a.$eval('.intro', e => e.textContent ?? '')).includes('SharedWorker'))

    // ── chat list: mike, infinite scroll ────────────────────────────────────────────────────
    await clickText(a, '.account', 'mike')
    check('clicking mike opens his chat list', await waitUntil(async () => (await a.$$('.chat-row')).length >= 20))
    const mike_id = a.url().split('/accounts/')[1]!
    const total_chats = (await api(`accounts/${mike_id}/chats?:limit=1`)).count.total as number
    await a.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    check('scrolling shows every chat (30 per page, from the device)', await waitUntil(async () => (await a.$$('.chat-row')).length === total_chats), `${(await a.$$('.chat-row')).length}/${total_chats}`)

    // ── mike opens the chat with bob; older messages on scroll ─────────────────────────────
    await a.evaluate(() => window.scrollTo(0, 0))
    await clickText(a, '.chat-row', 'bob')
    check('the chat opens with its latest messages', await waitUntil(async () => (await a.$$('.bubble-row')).length >= 30))
    const chat_url = a.url()
    const first_messages = (await a.$$('.bubble-row')).length
    await a.$eval('.messages', el => { el.scrollTop = -el.scrollHeight })
    check('scrolling up loads older messages', await waitUntil(async () => (await a.$$('.bubble-row')).length > first_messages), `${first_messages} → ${(await a.$$('.bubble-row')).length}`)

    const chat_id = chat_url.split('/chats/')[1]!
    const bob_id = (await api('accounts?:limit=100')).items.find((x: any) => x.name === 'bob').id as string

    // ── bob: tab B (same browser) and device C (another browser), on the same chat ──────────
    for (const page of [b, c]) {
        await front(page)
        await page.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
        await waitUntil(async () => (await clickText(page, '.account', 'bob')))
        // The direct chat titled "mike" — not a group whose last message mentions him.
        await waitUntil(async () => await page.$$eval('.chat-row', rows => {
            const row = rows.find(r => r.querySelector('.chat-title')?.textContent === 'mike') as HTMLElement | undefined
            row?.click()
            return !!row
        }))
    }
    check('bob opens the chat with mike in tab B and on device C', await waitUntil(async () =>
        b.url().endsWith(chat_id) && c.url().endsWith(chat_id)
        && (await b.$$('.bubble-row')).length >= 30 && (await c.$$('.bubble-row')).length >= 30), `${b.url().split('/').pop()} ${c.url().split('/').pop()}`)

    // ── realtime across devices, sent → seen ────────────────────────────────────────────────
    await front(a)
    const hello = `hello-${Date.now()}`
    await send(a, hello)
    check('mike sees his message at once', await waitUntil(async () => !!(await bubble(a, hello)), 2000))
    check('it becomes sent (✓)', await waitUntil(async () => {
        const d = (await bubble(a, hello))?.delivery ?? ''
        return d.includes('✓') && !d.includes('Gửi lỗi')
    }), (await bubble(a, hello))?.delivery)
    check('device C receives it through the server in realtime', await waitUntil(async () => !!(await bubble(c, hello))))
    await front(c)
    check('bob reading it on device C turns it into seen (✓✓ Đã xem) for mike', await waitUntil(async () => ((await bubble(a, hello))?.delivery ?? '').includes('Đã xem'), 15000), (await bubble(a, hello))?.delivery)

    // ── offline: queued, visible in the other tab at once, sent when back online ───────────
    await setOnline(a, false)
    check('the offline switch is shared by both tabs', await waitUntil(async () => (await b.$eval('.network-label', e => e.textContent)) === 'Offline'))
    const offline = `offline-${Date.now()}`
    await send(a, offline)
    check('offline, the message waits (🕓 Chờ gửi)', await waitUntil(async () => ((await bubble(a, offline))?.delivery ?? '').includes('Chờ gửi')), (await bubble(a, offline))?.delivery)
    check('the other tab sees it at once, before the server does', await waitUntil(async () => !!(await bubble(b, offline)), 3000))
    check('the server does not have it yet', !((await api(`chats/${chat_id}/messages?:limit=5&created_at:sort=desc`)).items ?? []).some((m: any) => m.text === offline))
    check('device C does not have it yet', !(await bubble(c, offline)))
    await setOnline(b, true)
    check('back online, it is sent', await waitUntil(async () => {
        const d = (await bubble(a, offline))?.delivery ?? ''
        return d.includes('✓') && !d.includes('Chờ')
    }, 15000), (await bubble(a, offline))?.delivery)
    check('…and device C receives it', await waitUntil(async () => !!(await bubble(c, offline))))
    check('…and the server has it', await waitUntil(async () => ((await api(`chats/${chat_id}/messages?:limit=5&created_at:sort=desc`)).items ?? []).some((m: any) => m.text === offline)))

    // ── refused: /fail → failed, discard ────────────────────────────────────────────────────
    const refused = `/fail ${Date.now()}`
    await send(a, refused)
    check('a refused message shows as failed with actions', await waitUntil(async () => !!(await bubble(a, refused))?.failed), (await bubble(a, refused))?.delivery)
    check('it is marked ⚠ Gửi lỗi', ((await bubble(a, refused))?.delivery ?? '').includes('Gửi lỗi'))
    await front(a)
    await a.$$eval('.bubble-row', (rows, t) => {
        const row = rows.find(r => r.querySelector('.bubble-text')?.textContent === t)
        ;(row?.querySelectorAll('.failed-actions button')[1] as HTMLElement | undefined)?.click()
    }, refused)
    check('Xoá removes it', await waitUntil(async () => !(await bubble(a, refused))))
    check('device C never saw it', !(await bubble(c, refused)))

    // ── bob's chat list on device C: latest message on top ──────────────────────────────────
    await front(c)
    await c.goto(`${URL}/accounts/${bob_id}`, { waitUntil: 'domcontentloaded' })
    check('bob\'s chat list shows the latest message on top', await waitUntil(async () => {
        const top = await c.$eval('.chat-row .chat-last', e => e.textContent ?? '')
        return top.includes(offline)
    }))
    await front(a)
    await a.goto(`${URL}/accounts/${mike_id}`, { waitUntil: 'domcontentloaded' })
    await waitUntil(async () => (await a.$$('.chat-row')).length > 0)
    const bob_row_unread = async () => c.$$eval('.chat-row', rows => rows.find(r => r.querySelector('.chat-title')?.textContent === 'mike')?.querySelector('.unread-badge')?.textContent ?? '0')
    // Bob must not have the chat open anywhere, or he reads it at once.
    await b.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
    const note = `unread-${Date.now()}`
    await a.goto(chat_url, { waitUntil: 'domcontentloaded' })
    await waitUntil(async () => (await a.$$('.bubble-row')).length > 0)
    await send(a, note)
    await waitUntil(async () => ((await bubble(a, note))?.delivery ?? '').includes('✓'))
    await front(c)
    const bob_row = () => c.$$eval('.chat-row', rows => rows.find(r => r.querySelector('.chat-title')?.textContent === 'mike')?.textContent ?? 'no row')
    check('a message bob has not read shows as unread in his chat list', await waitUntil(async () => Number(await bob_row_unread()) >= 1), `${await bob_row_unread()} — ${await bob_row()} — ${c.url()}`)

    // ── join with a new name: the account is created on the server ─────────────────────────
    const tester = `tester${Date.now() % 100000}`
    await front(a)
    await a.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
    await a.waitForSelector('.join input')
    // Wait for the account list to settle, or the form moves under the pointer.
    await waitUntil(async () => (await a.$$('.account')).length >= 3)
    await a.type('.join input', tester)
    await a.keyboard.press('Enter')
    check('joining by name creates the account on the server', await waitUntil(async () => (await api('accounts?:limit=100')).items.some((x: any) => x.name === tester)))
    check('…and opens its chat list', await waitUntil(async () => a.url().includes('/accounts/') && !a.url().endsWith('/accounts')))

    // ── device D: alice as a PWA, losing the network for real ──────────────────────────────
    const pwa = await browser.createBrowserContext({ proxyServer: `http://127.0.0.1:${proxy.port}` })
    const d = await pwa.newPage()
    d.on('pageerror', e => errors.push(String(e)))
    await front(d)
    await d.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
    await waitUntil(async () => (await clickText(d, '.account', 'alice')))
    check('alice\'s chat list loads (online, first visit)', await waitUntil(async () => (await d.$$('.chat-row')).length > 0))
    const alice_id = d.url().split('/accounts/')[1]!
    const alice_chats = (await api(`accounts/${alice_id}/chats?:limit=100&active_at:sort=desc`)).items as any[]
    const unopened = alice_chats.find(x => x.title === 'Team livequery')
    // Reloaded once so the service worker controls the page.
    check('the service worker installs', await waitUntil(async () => await d.evaluate(async () => !!(await navigator.serviceWorker.ready).active), 15000))
    await d.reload({ waitUntil: 'domcontentloaded' })
    check('…and controls the page', await waitUntil(async () => await d.evaluate(() => !!navigator.serviceWorker.controller)))
    check('the manifest is linked (installable)', await d.evaluate(async () => {
        const href = document.querySelector('link[rel=manifest]')?.getAttribute('href')
        return !!href && (await fetch(href)).ok
    }))
    // The chat list declares each chat's newest messages: give the background sync a moment.
    const synced = async () => d.evaluate(() => new Promise<number>(resolve => {
        const open = indexedDB.open('livequery-chat-demo')
        open.onsuccess = () => {
            const db = open.result
            const stores = [...db.objectStoreNames]
            if (stores.length === 0) return resolve(0)
            const tx = db.transaction(stores, 'readonly')
            let count = 0
            let pending = stores.length
            for (const name of stores) {
                const req = tx.objectStore(name).count()
                req.onsuccess = () => { count += req.result; if (--pending === 0) resolve(count) }
                req.onerror = () => { if (--pending === 0) resolve(count) }
            }
        }
        open.onerror = () => resolve(0)
    }))
    await waitUntil(async () => (await synced()) > alice_chats.length + 20, 20000)

    setNetwork(false)
    check('network cut: the API is unreachable from device D', await d.evaluate(async url => fetch(url).then(() => false, () => true), `${URL}/health?probe=${Date.now()}`))
    await d.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    check('offline reload: the app opens from the service worker', await waitUntil(async () => (await d.$$('.chat-row')).length > 0, 15000))
    check('…and shows every chat from the device', await waitUntil(async () => (await d.$$('.chat-row')).length === alice_chats.length), `${(await d.$$('.chat-row')).length}/${alice_chats.length}`)
    check('the status document says Offline', await waitUntil(async () => (await d.$eval('.network-label', e => e.textContent)) === 'Offline'))
    await clickText(d, '.chat-row', 'Team livequery')
    check('a chat never opened on this device opens offline, with its messages', await waitUntil(async () => (await d.$$('.bubble-row')).length >= 10), `${(await d.$$('.bubble-row')).length} messages`)
    const queued = `pwa-offline-${Date.now()}`
    await send(d, queued)
    check('a message sent offline waits (🕓 Chờ gửi)', await waitUntil(async () => ((await bubble(d, queued))?.delivery ?? '').includes('Chờ gửi')), (await bubble(d, queued))?.delivery)
    check('…and the status counts it as pending', await waitUntil(async () => ((await d.$eval('.network', e => e.textContent ?? '')).includes('1 chờ gửi'))))
    await d.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    check('after another offline reload it is still there, still waiting', await waitUntil(async () => ((await bubble(d, queued))?.delivery ?? '').includes('Chờ gửi'), 15000), (await bubble(d, queued))?.delivery)
    check('the server does not have it', !((await api(`chats/${unopened.id}/messages?:limit=5&created_at:sort=desc`)).items ?? []).some((m: any) => m.text === queued))

    setNetwork(true)
    check('network back: it is sent on its own', await waitUntil(async () => {
        const delivery = (await bubble(d, queued))?.delivery ?? ''
        return delivery.includes('✓') && !delivery.includes('Chờ')
    }, 30000), (await bubble(d, queued))?.delivery)
    check('…the server has it', await waitUntil(async () => ((await api(`chats/${unopened.id}/messages?:limit=5&created_at:sort=desc`)).items ?? []).some((m: any) => m.text === queued)))
    await front(a)
    await a.goto(`${URL}/accounts/${mike_id}/chats/${unopened.id}`, { waitUntil: 'domcontentloaded' })
    check('…and mike sees it', await waitUntil(async () => !!(await bubble(a, queued))))
    check('the status is Online again', await waitUntil(async () => (await d.$eval('.network-label', e => e.textContent)) === 'Online'))

    check('no page errors', errors.length === 0, errors.join(' | '))
    console.log(JSON.stringify({ cleanup: { chat_id, messages: [hello, offline, note, queued], account: tester } }))
} finally {
    await browser.close()
    proxy.stop(true)
}
