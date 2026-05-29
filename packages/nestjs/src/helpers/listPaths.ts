const REQUEST_METHODS = [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'ALL',
    'OPTIONS',
    'HEAD',
    'SEARCH',
] as const

function normalizePath(...parts: unknown[]): string {
    return parts
        .flat(3)
        .filter(part => part !== undefined && part !== null)
        .map(part => `${part}`.trim())
        .flatMap(part => part.split('/'))
        .filter(part => part.trim())
        .join('/')
}

export function listPaths(controllers: any[]): Array<{ method: string; path: string }> {
    return controllers.flatMap(controller => {
        const actions = Object.getOwnPropertyNames(controller.prototype)
            .filter(action => action !== 'constructor')
        const metadata = Reflect as any
        const prefixes = [metadata.getMetadata('path', controller) ?? ''].flat(2)

        return actions.flatMap(action => {
            const method = metadata.getMetadata('method', controller.prototype[action])
            if (method === undefined) return []
            const methodName = REQUEST_METHODS[method]
            if (!methodName) return []

            const paths = [metadata.getMetadata('path', controller.prototype[action]) ?? ''].flat(3)
            return prefixes.flatMap(prefix => paths.map(path => ({
                method: methodName,
                path: normalizePath(prefix, path),
            })))
        })
    })
}
