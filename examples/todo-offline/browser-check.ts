/**
 * Two tabs in a real Chrome (headless, throwaway profile) against a running demo:
 * the tabs share the SharedWorker, see each other's changes online and offline, the queue drains
 * when back online, data survives a reload.
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
const serverTitles = async () => ((await (await fetch(API)).json()).items ?? []).map((i: any) => i.title)

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
    check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
    await browser.close()
}
