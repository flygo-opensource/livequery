import { BehaviorSubject } from "rxjs";
import type { LivequeryCollection } from "./LivequeryCollection.js";
import type { Doc, DocState } from "./types.js";
import type { ActionMode } from "./index.js";



export class LivequeryDocument<T extends Doc> extends BehaviorSubject<DocState<T>> {

    constructor(
        public readonly collection: LivequeryCollection<T>,
        public document: T
    ) {
        super(document)
    }

    update(data: Partial<T>, mode: ActionMode = 'server-first') {
        const id = this.value.id 
        return this.collection.update(id, data, mode)
    }

    del(mode: ActionMode = 'server-first') {
        const id = this.value.id
        return this.collection.delete(id, mode)
    }

    trigger<T>(action: string, payload?: Record<string, any>) {
        return this.collection.trigger<T>(action, payload)
    }
}   