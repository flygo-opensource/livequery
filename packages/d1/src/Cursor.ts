// Edge-compatible cursor — uses btoa/atob instead of Buffer (not available in Workers)

export class Cursor {
    static encode(data: Record<string, unknown>): string {
        return btoa(unescape(encodeURIComponent(JSON.stringify(data))))
    }

    static decode(cursor: string): Record<string, unknown> | null {
        try {
            return JSON.parse(decodeURIComponent(escape(atob(cursor))))
        } catch {
            throw { status: 400, code: 'INVALID_CURSOR', message: 'Invalid pagination cursor' }
        }
    }

    static calculate(item: Record<string, unknown>, query: Record<string, unknown>): string | null {
        if (!item) return null
        const fields = Object.entries(query)
            .filter(([k]) => k.endsWith(':sort'))
            .reduce<Record<string, unknown>>((acc, [k]) => {
                const field = k.slice(0, -5)
                return { ...acc, [field]: item[field] }
            }, { id: item.id })
        return Cursor.encode(fields)
    }
}
