import { afterEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

type ProcessEvent = {
  event: string
  kind?: string
  nodeId?: string
  pid?: number
  port?: number
}

type ManagedProcess = {
  process: ReturnType<typeof Bun.spawn>
  events: ProcessEvent[]
  output: string[]
}

const processes: ManagedProcess[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stop))
})

describe('UDP API auto-discovery examples', () => {
  test('a service started first discovers a late gateway and becomes routable', async () => {
    const environment = discoveryEnvironment()
    const service = spawn('service.ts', environment)
    processes.push(service)
    const serviceReady = await waitForEvent(service, 'ready')

    const gateway = spawn('gateway.ts', environment)
    processes.push(gateway)
    const gatewayReady = await waitForEvent(gateway, 'ready')

    await Promise.all([
      waitForEvent(service, 'gateway-discovered'),
      waitForEvent(gateway, 'service-discovered'),
    ])
    await expectGatewayRoute(gatewayReady.port!, serviceReady.pid!)
  }, 10_000)

  test('a gateway started first discovers a late service and routes to it', async () => {
    const environment = discoveryEnvironment()
    const gateway = spawn('gateway.ts', environment)
    processes.push(gateway)
    const gatewayReady = await waitForEvent(gateway, 'ready')

    const service = spawn('service.ts', environment)
    processes.push(service)
    const serviceReady = await waitForEvent(service, 'ready')

    await Promise.all([
      waitForEvent(service, 'gateway-discovered'),
      waitForEvent(gateway, 'service-discovered'),
    ])
    await expectGatewayRoute(gatewayReady.port!, serviceReady.pid!)
  }, 10_000)
})

function discoveryEnvironment(): Record<string, string> {
  const identity = `udp-e2e-${Date.now()}-${Math.random()}`
  return {
    OHAYO_DISCOVERY_NAMESPACE: identity,
    OHAYO_DISCOVERY_KEY: identity,
    OHAYO_DISCOVERY_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
    OHAYO_SERVICE_HOST: '127.0.0.1',
  }
}

function spawn(filename: string, environment: Record<string, string>): ManagedProcess {
  const events: ProcessEvent[] = []
  const output: string[] = []
  const script = fileURLToPath(new URL(filename, import.meta.url))
  const child = Bun.spawn(['bun', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  readLines(child.stdout, line => {
    output.push(line)
    try {
      events.push(JSON.parse(line) as ProcessEvent)
    } catch {
      // Keep diagnostics in output; only JSON lines are process events.
    }
  })
  readLines(child.stderr, line => output.push(line))
  return { process: child, events, output }
}

async function waitForEvent(child: ManagedProcess, event: string): Promise<ProcessEvent> {
  return eventually(async () => {
    const found = child.events.find(item => item.event === event)
    if (found) return found
    if (child.process.exitCode !== null) {
      throw new Error(`Process exited before ${event}:\n${child.output.join('\n')}`)
    }
    throw new Error(`Waiting for ${event}`)
  })
}

async function expectGatewayRoute(gatewayPort: number, servicePid: number): Promise<void> {
  const body = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/livequery/catalog`)
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status}: ${text}`)
    return JSON.parse(text) as { service: string; serviceId: string; processId: number }
  })
  expect(body).toEqual({
    service: 'catalog',
    serviceId: expect.any(String),
    processId: servicePid,
  })
}

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await Bun.sleep(50)
    }
  }
  throw lastError
}

function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line)
    }
    if (buffer.trim()) onLine(buffer)
  })()
}

async function stop(child: ManagedProcess): Promise<void> {
  if (child.process.exitCode !== null) return
  child.process.kill('SIGTERM')
  await Promise.race([
    child.process.exited,
    Bun.sleep(1_000).then(() => {
      if (child.process.exitCode === null) child.process.kill('SIGKILL')
    }),
  ])
}
