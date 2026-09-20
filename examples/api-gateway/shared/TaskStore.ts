import { Subject } from 'rxjs'
import type { LivequeryRequest, UpdatedData } from '@livequery/core'

export type Task = {
    id: string
    title: string
    status: 'todo' | 'done'
    created_at: number
}

const STATUSES = new Set(['todo', 'done'])

function readBody(req: LivequeryRequest): Record<string, unknown> {
    const body = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw { status: 400, code: 'INVALID_BODY', message: 'Request body must be a JSON object' }
    }
    return body as Record<string, unknown>
}

function readStatus(value: unknown): Task['status'] {
    if (!STATUSES.has(String(value))) {
        throw { status: 400, code: 'INVALID_STATUS', message: 'status must be "todo" or "done"' }
    }
    return value as Task['status']
}

/**
 * In-memory task table. Stands in for MongoDB / Postgres / D1 so the example needs no database.
 * Every write is emitted on `changes$`; the service forwards it to its realtime gateway.
 */
export class TaskStore {
    readonly changes$ = new Subject<UpdatedData<Task>>()

    readonly #tasks = new Map<string, Task>()

    /** Collection read with `?status=` / `?title=` equality filters and `?:limit=`. */
    list(req: LivequeryRequest): { items: Task[] } {
        const query = req.query ?? {}
        const limit = Math.min(Number(query[':limit']) || 50, 100)
        const items = [...this.#tasks.values()]
            .filter(task => query.status === undefined || task.status === query.status)
            .filter(task => query.title === undefined || task.title === query.title)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, limit)
        return { items }
    }

    get(req: LivequeryRequest): { item: Task } {
        return { item: this.#find(req) }
    }

    add(req: LivequeryRequest): { item: Task } {
        const body = readBody(req)
        if (typeof body.title !== 'string' || !body.title.trim()) {
            throw { status: 400, code: 'MISSING_TITLE', message: 'title is required' }
        }
        const item: Task = {
            id: crypto.randomUUID(),
            title: body.title.trim(),
            status: body.status === undefined ? 'todo' : readStatus(body.status),
            created_at: Date.now(),
        }
        this.#tasks.set(item.id, item)
        this.changes$.next({ ref: 'tasks', type: 'added', data: item })
        return { item }
    }

    update(req: LivequeryRequest): { item: Task } {
        const body = readBody(req)
        const current = this.#find(req)
        const item: Task = {
            ...current,
            ...typeof body.title === 'string' ? { title: body.title.trim() } : {},
            ...body.status !== undefined ? { status: readStatus(body.status) } : {},
        }
        this.#tasks.set(item.id, item)
        this.changes$.next({ ref: 'tasks', type: 'modified', data: item })
        return { item }
    }

    delete(req: LivequeryRequest): { item: Task } {
        const item = this.#find(req)
        this.#tasks.delete(item.id)
        this.changes$.next({ ref: 'tasks', type: 'removed', data: item })
        return { item }
    }

    #find(req: LivequeryRequest): Task {
        const item = req.document_id ? this.#tasks.get(req.document_id) : undefined
        if (!item) throw { status: 404, code: 'NOT_FOUND', message: 'Task not found' }
        return item
    }
}
