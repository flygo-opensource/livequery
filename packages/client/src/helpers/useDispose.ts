


export const useDispose = <T>(fn: Function) => {
    return Object.assign({}, {
        [Symbol.dispose]() {
            fn()
        }
    }) as T & Disposable
}