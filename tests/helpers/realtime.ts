import type { AppHandle } from './servers.js'
import { sleep } from './wait.js'
import { fetchJson, wsStart } from './ws.js'

/**
 * MongoDB change streams open asynchronously; events emitted before the stream is
 * live are silently missed. Probe-insert into the collection until the first sync
 * arrives so tests never race stream startup.
 */
export async function warmupRealtime(app: AppHandle, ref = 'tasks', timeout = 20000) {
    const clientId = `warmup-${Date.now()}`
    const { ws, gatewayId } = await wsStart(app.wsUrl, clientId)
    await fetchJson(`${app.apiUrl}/${ref}`, { headers: { 'x-lcid': clientId, 'x-lgid': gatewayId } })
    await sleep(100)

    let ready = false
    ws.addEventListener('message', (e: MessageEvent) => {
        try { if (JSON.parse(e.data).event === 'sync') ready = true } catch { /* noop */ }
    })

    const started = Date.now()
    while (!ready && Date.now() - started < timeout) {
        await app.collection.insertOne({ __warmup: true })
        await sleep(300)
    }
    ws.close()
    if (!ready) throw new Error('Realtime change stream never became ready')

    await app.collection.deleteMany({ __warmup: true })
    await sleep(500) // let warmup removals flush before tests subscribe
}
