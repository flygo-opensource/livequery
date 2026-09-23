import { LivequeryClient, LivequeryIndexedDBStorage } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

/** The one client of this browser: IndexedDB on the device, REST + WebSocket to the server. */
export function createClient(origin: string) {
    return new LivequeryClient({
        storage: new LivequeryIndexedDBStorage({ name: 'livequery-todo-demo', persist: true }),
        transporters: {
            rest: new RestTransporter({
                api: `${origin}/livequery`,
                ws: `${origin.replace(/^http/, 'ws')}/livequery/realtime-updates`,
            }),
        },
    })
}
