/**
 * A real Chrome (headless, throwaway profile) against a running chat demo:
 *   tab A — mike, and tab B — bob, in the same profile: one SharedWorker, one storage;
 *   device C — bob in a separate browser context: its own worker and storage, like another
 *   computer, so what reaches it went through the server.
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
const API = `${URL}/livequery`
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    protocolTimeout: 30000,
    userDataDir: mkdtempSync(join(tmpdir(), 'lq-chat-')),
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=900,1000'],
})

const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
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
    check('infinite scroll loads every page of the chat list (20 per page)', await waitUntil(async () => (await a.$$('.chat-row')).length === total_chats), `${(await a.$$('.chat-row')).length}/${total_chats}`)

    // ── mike opens the chat with bob; older messages on scroll ─────────────────────────────
    await a.evaluate(() => window.scrollTo(0, 0))
    await clickText(a, '.chat-row', 'bob')
    check('the chat opens with its latest messages', await waitUntil(async () => (await a.$$('.bubble-row')).length >= 30))
    const chat_url = a.url()
    const first_messages = (await a.$$('.bubble-row')).length
    await a.$eval('.messages', el => { el.scrollTop = -el.scrollHeight })
    check('scrolling up loads older messages', await waitUntil(async () => (await a.$$('.bubble-row')).length > first_messages), `${first_messages} → ${(await a.$$('.bubble-row')).length}`)

    const chat_id = chat_url.split('/chats/')[1]!
    const bob_id = (await api('accounts')).items.find((x: any) => x.name === 'bob').id as string

    // ── bob: tab B (same browser) and device C (another browser), on the same chat ──────────
    for (const page of [b, c]) {
        await front(page)
        await page.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
        await waitUntil(async () => (await clickText(page, '.account', 'bob')))
        await waitUntil(async () => (await page.$$('.chat-row')).length > 0)
        await clickText(page, '.chat-row', 'mike')
    }
    check('bob opens the chat with mike in tab B and on device C', await waitUntil(async () =>
        (await b.$$('.bubble-row')).length >= 30 && (await c.$$('.bubble-row')).length >= 30))

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
    const note = `unread-${Date.now()}`
    await a.goto(chat_url, { waitUntil: 'domcontentloaded' })
    await waitUntil(async () => (await a.$$('.bubble-row')).length > 0)
    await send(a, note)
    check('a message bob has not read shows as unread in his chat list', await waitUntil(async () => Number(await bob_row_unread()) >= 1), await bob_row_unread())

    // ── join with a new name: the account is created on the server ─────────────────────────
    const tester = `tester${Date.now() % 100000}`
    await front(a)
    await a.goto(`${URL}/accounts`, { waitUntil: 'domcontentloaded' })
    await a.waitForSelector('.join input')
    // Wait for the account list to settle, or the form moves under the pointer.
    await waitUntil(async () => (await a.$$('.account')).length >= 3)
    await a.type('.join input', tester)
    await a.keyboard.press('Enter')
    check('joining by name creates the account on the server', await waitUntil(async () => (await api('accounts')).items.some((x: any) => x.name === tester)))
    check('…and opens its chat list', await waitUntil(async () => a.url().includes('/accounts/') && !a.url().endsWith('/accounts')))
    check('no page errors', errors.length === 0, errors.join(' | '))
    console.log(JSON.stringify({ cleanup: { chat_id, messages: [hello, offline, note], account: tester } }))
} finally {
    await browser.close()
}
