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

