import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'

const FORBIDDEN = /^(node:|ws$|http2?$|https$|crypto$|dgram$|net$|os$|fs$|@livequery\/core\/(node|bun)$)/

// Follows relative imports from an entry and collects every bare specifier it reaches.
function collectSpecifiers(entry: string): Set<string> {
    const found = new Set<string>()
    const seen = new Set<string>()
    const visit = (file: string) => {
        if (seen.has(file)) return
        seen.add(file)
        const source = readFileSync(file, 'utf8')
        // `import type` is erased at build time, so it cannot pull a runtime module in.
        for (const [statement, specifier] of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
            if (!specifier || /^(import|export)\s+type\s/.test(statement)) continue
            if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
            else found.add(specifier)
        }
    }
    visit(entry)
    return found
}

describe('entrypoints', () => {
    test('the root entry is safe on Cloudflare Workers', () => {
        const specifiers = collectSpecifiers(resolve(import.meta.dir, '../src/index.ts'))
        expect([...specifiers].filter(s => FORBIDDEN.test(s))).toEqual([])
    })

    test('the /bun entry never loads ws or UDP', () => {
        const specifiers = collectSpecifiers(resolve(import.meta.dir, '../src/bun.ts'))
        expect([...specifiers].filter(s => /^(ws|@ohayo\/udp|@livequery\/core\/(node|udp))$/.test(s))).toEqual([])
    })
})
