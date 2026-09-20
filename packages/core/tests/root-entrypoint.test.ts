import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import * as root from '../src/index.js'

const FORBIDDEN = /^(node:|ws$|http2?$|https$|crypto$|dgram$|net$|os$|fs$|@ohayo\/udp$)/

// Follows relative imports from an entry file and collects every bare specifier it reaches.
function collectSpecifiers(entry: string): Map<string, string> {
    const found = new Map<string, string>()
    const seen = new Set<string>()
    const visit = (file: string) => {
        if (seen.has(file)) return
        seen.add(file)
        const source = readFileSync(file, 'utf8')
        for (const [, specifier] of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
            if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
            else found.set(specifier, file)
        }
    }
    visit(entry)
    return found
}

describe('root entrypoint', () => {
    test('reaches no Node built-in, ws or UDP module', () => {
        const specifiers = collectSpecifiers(resolve(import.meta.dir, '../src/index.ts'))
        const offending = [...specifiers].filter(([specifier]) => FORBIDDEN.test(specifier))
        expect(offending).toEqual([])
    })

    test('keeps the runtime-neutral API and drops the Node adapters', () => {
        expect(typeof root.LivequeryRequestParser).toBe('function')
        expect(typeof root.WebsocketGatewayBase).toBe('function')
        expect(typeof root.hidePrivateFields).toBe('function')
        expect(root.WEBSOCKET_PATH).toBe('/livequery/realtime-updates')
        expect('WebsocketGateway' in root).toBe(false)
        expect('UdpDiscovery' in root).toBe(false)
        expect('ApiGatewayHandler' in root).toBe(false)
    })

    test('the /node and /bun entries never load the optional @ohayo/udp peer', () => {
        for (const entry of ['node.ts', 'bun.ts']) {
            const specifiers = collectSpecifiers(resolve(import.meta.dir, `../src/${entry}`))
            expect(specifiers.has('@ohayo/udp')).toBe(false)
        }
    })

    test('the /workers entry is runtime-neutral too', () => {
        const specifiers = collectSpecifiers(resolve(import.meta.dir, '../src/workers.ts'))
        expect([...specifiers.keys()].filter(s => FORBIDDEN.test(s))).toEqual([])
    })
})
