const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** '30s' | '10m' | '24h' | '30d' | a number of ms → ms. 'always' → Infinity. */
export function parseDuration(value: string | number | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (value === 'always') return Infinity
    if (typeof value === 'number') return value
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim())
    if (!match) throw new Error(`Invalid duration "${value}": use e.g. '30s', '10m', '24h', '30d' or 'always'`)
    return Number(match[1]) * UNITS[match[2]!]!
}
