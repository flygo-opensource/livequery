import { BehaviorSubject } from "rxjs";
import type { LivequeryCollection } from "./LivequeryCollection";
import type { Doc } from "./types";



export class LivequeryDocument<T extends Doc> extends BehaviorSubject<T> {

    constructor(
        public readonly collection: LivequeryCollection<T>,
        public document: T
    ) {
        super(document)
    }

    update(data: Partial<T>) {
        const id = this.value.id
        return this.collection.update(id, data)
    }

    del() {
        const id = this.value.id
        return this.collection.delete(id)
    }

    trigger<T>(action: string, payload: Record<string, any>) {
        return this.collection.trigger<T>(action, payload)
    }
}   