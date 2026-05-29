export class RxjsQueue {

    #limit: number
    #running = 0
    #queue: Array<{ fn: Function, s: (value: any) => void, r: (error: any) => void }> = []

    constructor(limit: number = 1) {
        this.#limit = Math.max(1, limit)
    }

    updateLimit(limit: number) {
        this.#limit = Math.max(1, limit)
        this.#drain()
    }

    run(fn: () => Promise<any>) {
        return new Promise((s, r) => {
            this.#queue.push({ fn, s, r })
            this.#drain()
        })
    }

    #drain() {
        while (this.#running < this.#limit && this.#queue.length > 0) {
            const task = this.#queue.shift()!
            this.#running++
            task.fn().then(
                (v: any) => { this.#running--; task.s(v); this.#drain() },
                (e: any) => { this.#running--; task.r(e); this.#drain() }
            )
        }
    }
}
