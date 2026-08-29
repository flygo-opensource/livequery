import { LivequeryClient, LivequeryMemoryStorage } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787'

export const client = new LivequeryClient({
    storage: new LivequeryMemoryStorage(),
    transporters: {
        default: new RestTransporter({
            // Include /livequery in api so refs like 'tasks' map to /livequery/tasks
            api: WORKER_URL + '/livequery',
            ws: WORKER_URL.replace(/^http/, 'ws') + '/livequery/realtime-updates',
        }),
    },
})
