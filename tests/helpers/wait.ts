export function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** Poll `check` until it returns truthy or timeout. Returns the truthy value. */
export async function waitFor<T>(
    check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
    { timeout = 8000, interval = 25, label = 'condition' } = {},
): Promise<T> {
    const started = Date.now()
    while (true) {
        const value = await check()
        if (value) return value
        if (Date.now() - started > timeout) {
            throw new Error(`Timed out waiting for ${label}`)
        }
        await sleep(interval)
    }
}

/** Wait until an event matching `predicate` appears in `events` (array filled elsewhere). */
export function waitForEvent<T>(
    events: Array<T>,
    predicate: (event: T) => boolean,
    { timeout = 8000, label = 'event' } = {},
): Promise<T> {
    return waitFor(() => events.find(predicate), { timeout, label })
}
