import { BehaviorSubject } from "rxjs"

export type IStorage = {
    getItem: <T>(key: string) => Promise<T | undefined> | T | undefined
    setItem: <T>(key: string, value: T) => void
}




export class StorageBehaviorSubject<T> extends BehaviorSubject<T> {
    constructor(private storage: IStorage, private key: string, defaultValue: T) {
        const value = storage.getItem<T>(key)
        super(value instanceof Promise ? defaultValue : value || defaultValue)
        if (value instanceof Promise) {
            value.then(v => this.next(v ?? defaultValue))
        }
    }

    override next(value: T) {
        super.next(value)
        this.storage.setItem(this.key, value)
    }
}
