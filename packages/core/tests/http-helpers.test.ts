import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import { nodeRequestToWebRequest } from '../src/helpers/nodeRequestToWebRequest.js'
import { writeWebResponse } from '../src/helpers/writeWebResponse.js'

describe('HTTP helpers', () => {
    test('nodeRequestToWebRequest preserves URL, method, headers, and raw body', async () => {
        const req = {
            url: '/livequery/posts?limit=1',
            method: 'POST',
            rawBody: Buffer.from(JSON.stringify({ title: 'Hello' })),
            headers: {
                host: 'api.local',
                'content-type': 'application/json',
            },
        } as http.IncomingMessage & { url: string; method: string; rawBody?: Buffer }

        const request = nodeRequestToWebRequest(req, { 'x-extra': 'yes' })

        expect(request.url).toBe('http://api.local/livequery/posts?limit=1')
        expect(request.method).toBe('POST')
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(request.headers.get('x-extra')).toBe('yes')
        expect(await request.json()).toEqual({ title: 'Hello' })
    })

    test('nodeRequestToWebRequest streams the body of an unbuffered IncomingMessage', async () => {
        const server = http.createServer(async (req, res) => {
            const request = nodeRequestToWebRequest(req as http.IncomingMessage & { url: string; method: string })
            res.end(JSON.stringify(await request.json()))
        })
        await new Promise<void>(resolve => server.listen(0, resolve))
        const { port } = server.address() as { port: number }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/livequery/posts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'Streamed' }),
            })
            expect(await response.json()).toEqual({ title: 'Streamed' })
        } finally {
            server.close()
        }
    })

    test('nodeRequestToWebRequest omits the body when the stream was already consumed', async () => {
        const server = http.createServer(async (req, res) => {
            for await (const _chunk of req) { /* a caller buffered the (empty) body first */ }
            const request = nodeRequestToWebRequest(req as http.IncomingMessage & { url: string; method: string })
            res.end(JSON.stringify({ body: request.body === null }))
        })
        await new Promise<void>(resolve => server.listen(0, resolve))
        const { port } = server.address() as { port: number }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/livequery/posts/p1`, { method: 'DELETE' })
            expect(await response.json()).toEqual({ body: true })
        } finally {
            server.close()
        }
    })

    test('nodeRequestToWebRequest omits body for GET requests', async () => {
        const req = {
            url: '/livequery/posts',
            method: 'GET',
            rawBody: Buffer.from('ignored'),
            headers: {},
        } as http.IncomingMessage & { url: string; method: string; rawBody?: Buffer }

        const request = nodeRequestToWebRequest(req)

        expect(request.url).toBe('http://127.0.0.1/livequery/posts')
        expect(request.method).toBe('GET')
        expect(request.body).toBeNull()
    })

    test('writeWebResponse copies status, headers, and body to ServerResponse-like objects', async () => {
        const writes: unknown[] = []
        const response = new Response('created', {
            status: 201,
            headers: { 'x-created': 'yes' },
        })
        const res = {
            writeHead(status: number, headers: Record<string, string>) {
                writes.push({ status, headers })
            },
            end(body: Buffer) {
                writes.push(body.toString())
            },
        } as unknown as http.ServerResponse

        await writeWebResponse(res, response)

        expect(writes).toEqual([
            { status: 201, headers: { 'x-created': 'yes' } },
            'created',
        ])
    })
})
