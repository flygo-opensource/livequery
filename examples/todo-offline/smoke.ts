/**
 * Smoke test against a deployed demo: two clients, one adds, the other must see it by realtime.
 *
 *   bun examples/todo-offline/smoke.ts https://livequery-demo.global.flygo.vn
 */
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

const base = process.argv[2] ?? 'http://localhost:8090'
type Todo = { id: string, title: string, done: boolean, created_at: number }

const device = () => {
    const transporter = new RestTransporter({
        api: `${base}/livequery`,
        ws: `${base.replace(/^http/, 'ws')}/livequery/realtime-updates`,
    })
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
    const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
    col.initialize('todos')
    return { transporter, client, col }
}

const waitFor = async (check: () => boolean, label: string, ms = 15000) => {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error(`timed out: ${label}`)
        await new Promise(r => setTimeout(r, 100))
    }
}

const a = device()
const b = device()
let connected = false
b.transporter.status$?.subscribe(s => { connected = s.connected })
await waitFor(() => connected, 'device B socket connected')
await new Promise(r => setTimeout(r, 1500))

const title = `smoke-${Date.now()}`
const created = await a.col.add({ title, done: false, created_at: Date.now() })
console.log('A added', created.id)
await waitFor(() => b.col.items.value.some(d => d.value.id === created.id), 'device B received the add by realtime')
console.log('B received it by realtime')

await a.col.delete(created.id)
await waitFor(() => !b.col.items.value.some(d => d.value.id === created.id), 'device B received the delete')
console.log('B received the delete — OK')

for (const d of [a, b]) {
    d.client.destroy()
    ;(d.transporter as any).socket?.stop?.()
}
process.exit(0)
