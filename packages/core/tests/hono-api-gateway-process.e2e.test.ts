import { afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'url'

type ReadyMessage = {
    event: 'ready'
    kind: string
    pid: number
    port: number
}

type ManagedProcess = {
    proc: ReturnType<typeof Bun.spawn>
    ready: Promise<ReadyMessage>
    stdout: string[]
    stderr: string[]
}

const processes: ManagedProcess[] = []

afterEach(async () => {
    await Promise.all(processes.splice(0).map(stopProcess))
})

describe('Hono services behind ApiGatewayHandler in separate processes', () => {
    test('routes through one gateway process to two service processes via UDP discovery', async () => {
        const sharedEnv = createSharedEnv()

        const gateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const catalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })
        const orders = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'orders',
        })

        processes.push(gateway, catalog, orders)

        const [gatewayReady, catalogReady, ordersReady] = await Promise.all([
            gateway.ready,
            catalog.ready,
            orders.ready,
        ])

        expect(new Set([
            gatewayReady.pid,
            catalogReady.pid,
            ordersReady.pid,
        ]).size).toBe(3)

        const catalogJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/catalog'
        )
        const orderJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/orders/order-1?include=items',
            { 'x-request-id': 'process-e2e-request' }
        )
        const updateJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/orders/order-2?include=items',
            {
                'content-type': 'application/json',
            },
            {
                method: 'POST',
                body: JSON.stringify({ status: 'running' }),
            }
        )

        expect(catalogJson).toEqual({
            service: 'catalog',
            runtime: 'hono',
            process_id: catalogReady.pid,
            items: ['book', 'pen'],
        })
        expect(orderJson).toEqual({
            service: 'orders',
            runtime: 'hono',
            process_id: ordersReady.pid,
            id: 'order-1',
            include: 'items',
            request_id: 'process-e2e-request',
        })
        expect(updateJson).toEqual({
            service: 'orders',
            runtime: 'hono',
            process_id: ordersReady.pid,
            id: 'order-2',
            include: 'items',
            body: { status: 'running' },
        })
    }, 10_000)

    test('services that start before the gateway are linked after gateway discovery', async () => {
        const sharedEnv = createSharedEnv()
        const catalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })
        const orders = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'orders',
        })

        processes.push(catalog, orders)
        const [catalogReady, ordersReady] = await Promise.all([
            catalog.ready,
            orders.ready,
        ])

        const gateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        processes.push(gateway)
        const gatewayReady = await gateway.ready

        const catalogJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/catalog'
        )
        const orderJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/orders/order-before-gateway'
        )

        expect(catalogJson).toMatchObject({
            service: 'catalog',
            process_id: catalogReady.pid,
        })
        expect(orderJson).toMatchObject({
            service: 'orders',
            process_id: ordersReady.pid,
            id: 'order-before-gateway',
        })
    }, 10_000)

    test('a stopped service returns 502 once then 503 while other services keep working', async () => {
        const sharedEnv = createSharedEnv()
        const gateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const catalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })
        const orders = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'orders',
        })

        processes.push(gateway, catalog, orders)
        const [gatewayReady, catalogReady, ordersReady] = await Promise.all([
            gateway.ready,
            catalog.ready,
            orders.ready,
        ])

        expect(await fetchGatewayJson(gatewayReady.port, '/livequery/catalog')).toMatchObject({
            service: 'catalog',
            process_id: catalogReady.pid,
        })

        await stopProcess(catalog)

        const first = await fetch(`http://127.0.0.1:${gatewayReady.port}/livequery/catalog`)
        const second = await fetch(`http://127.0.0.1:${gatewayReady.port}/livequery/catalog`)
        const orderJson = await fetchGatewayJson(
            gatewayReady.port,
            '/livequery/orders/order-after-catalog-stop'
        )

        expect(first.status).toBe(502)
        expect(await first.json()).toMatchObject({
            error: { status: 502, code: 'SERVICE_API_OFFLINE' },
        })
        expect(second.status).toBe(503)
        expect(await second.json()).toMatchObject({
            error: { status: 503, code: 'API_OFFLINE' },
        })
        expect(orderJson).toMatchObject({
            service: 'orders',
            process_id: ordersReady.pid,
            id: 'order-after-catalog-stop',
        })
    }, 10_000)

    test('round-robins between two service processes with the same route', async () => {
        const sharedEnv = createSharedEnv()
        const gateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const firstMirror = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'mirror',
        })
        const secondMirror = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'mirror',
        })

        processes.push(gateway, firstMirror, secondMirror)
        const [gatewayReady, firstReady, secondReady] = await Promise.all([
            gateway.ready,
            firstMirror.ready,
            secondMirror.ready,
        ])

        const responses = await eventually(async () => {
            const attempts = [
                await fetchGatewayJson(gatewayReady.port, '/livequery/shared'),
                await fetchGatewayJson(gatewayReady.port, '/livequery/shared'),
                await fetchGatewayJson(gatewayReady.port, '/livequery/shared'),
            ] as Array<{ process_id: number }>
            if (new Set(attempts.slice(0, 2).map(item => item.process_id)).size !== 2) {
                throw new Error(`Expected first two responses from different processes: ${JSON.stringify(attempts)}`)
            }
            return attempts
        })

        expect(new Set([
            responses[0].process_id,
            responses[1].process_id,
        ])).toEqual(new Set([firstReady.pid, secondReady.pid]))
        expect(responses[2].process_id).toBe(responses[0].process_id)
    }, 10_000)

    test('multiple gateway processes in the same namespace can route to the same service', async () => {
        const sharedEnv = createSharedEnv()
        const firstGateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const secondGateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const catalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })

        processes.push(firstGateway, secondGateway, catalog)
        const [firstGatewayReady, secondGatewayReady, catalogReady] = await Promise.all([
            firstGateway.ready,
            secondGateway.ready,
            catalog.ready,
        ])

        const firstJson = await fetchGatewayJson(firstGatewayReady.port, '/livequery/catalog')
        const secondJson = await fetchGatewayJson(secondGatewayReady.port, '/livequery/catalog')

        expect(firstJson).toMatchObject({
            service: 'catalog',
            process_id: catalogReady.pid,
        })
        expect(secondJson).toMatchObject({
            service: 'catalog',
            process_id: catalogReady.pid,
        })
    }, 10_000)

    test('a restarted service process can register again after the old route went offline', async () => {
        const sharedEnv = createSharedEnv()
        const gateway = spawnFixture('hono-gateway-process.ts', sharedEnv)
        const catalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })

        processes.push(gateway, catalog)
        const [gatewayReady, catalogReady] = await Promise.all([
            gateway.ready,
            catalog.ready,
        ])

        expect(await fetchGatewayJson(gatewayReady.port, '/livequery/catalog')).toMatchObject({
            service: 'catalog',
            process_id: catalogReady.pid,
        })

        await stopProcess(catalog)
        const offline = await fetch(`http://127.0.0.1:${gatewayReady.port}/livequery/catalog`)
        expect(offline.status).toBe(502)

        const restartedCatalog = spawnFixture('hono-service-process.ts', {
            ...sharedEnv,
            SERVICE_KIND: 'catalog',
        })
        processes.push(restartedCatalog)
        const restartedReady = await restartedCatalog.ready

        const restartedJson = await fetchGatewayJson(gatewayReady.port, '/livequery/catalog')
        expect(restartedJson).toMatchObject({
            service: 'catalog',
            process_id: restartedReady.pid,
        })
    }, 10_000)
})

function createSharedEnv(): Record<string, string> {
    return {
        API_GATEWAY_NAMESPACE: `hono-process-e2e-${Date.now()}-${Math.random()}`,
        LIVEQUERY_MAGIC_KEY: `hono-process-e2e-${Date.now()}-${Math.random()}`,
        UDP_PUBLIC_PORT: String(30_000 + Math.floor(Math.random() * 10_000)),
        UDP_WHITELIST_ADDRESS: '127.0.0.1',
    }
}

function spawnFixture(
    filename: string,
    env: Record<string, string>,
): ManagedProcess {
    const stdout: string[] = []
    const stderr: string[] = []
    let resolved = false
    let resolveReady: (message: ReadyMessage) => void
    let rejectReady: (error: Error) => void
    const ready = new Promise<ReadyMessage>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
    })
    const script = fileURLToPath(new URL(`./fixtures/${filename}`, import.meta.url))
    const proc = Bun.spawn(['bun', script], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })

    readLines(proc.stdout, line => {
        stdout.push(line)
        try {
            const parsed = JSON.parse(line) as ReadyMessage
            if (parsed.event === 'ready' && !resolved) {
                resolved = true
                resolveReady(parsed)
            }
        } catch {
            // Ignore non-JSON diagnostic output.
        }
    })
    readLines(proc.stderr, line => stderr.push(line))

    proc.exited.then(code => {
        if (!resolved) {
            rejectReady(new Error(
                `Process ${filename} exited before ready with code ${code}\n`
                + [...stdout, ...stderr].join('\n')
            ))
        }
    })

    return { proc, ready, stdout, stderr }
}

function readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
): void {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''

    const pump = async () => {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += value
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                if (line.trim()) onLine(line)
            }
        }
        if (buffer.trim()) onLine(buffer)
    }

    pump().catch(() => {})
}

async function fetchGatewayJson(
    port: number,
    path: string,
    headers?: Record<string, string>,
    init?: RequestInit,
): Promise<unknown> {
    return eventually(async () => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            ...init,
            headers,
        })
        const body = await response.text()
        if (response.status !== 200) {
            throw new Error(`Expected 200, got ${response.status}: ${body}`)
        }
        return JSON.parse(body)
    })
}

async function eventually<T>(
    fn: () => Promise<T>,
    timeoutMs = 5_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
        try {
            return await fn()
        } catch (error) {
            lastError = error
            await sleep(100)
        }
    }
    throw lastError
}

async function stopProcess({ proc }: ManagedProcess): Promise<void> {
    if (proc.exitCode !== null) return
    proc.kill('SIGTERM')
    await Promise.race([
        proc.exited,
        sleep(1_000).then(() => {
            if (proc.exitCode === null) proc.kill('SIGKILL')
        }),
    ])
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
