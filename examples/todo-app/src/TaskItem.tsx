import { useObservable } from '@livequery/react'
import type { LivequeryDocument, DocState } from '@livequery/client'
import type { Task, TaskStatus } from './types'

const STATUS_NEXT: Record<TaskStatus, TaskStatus> = {
    todo: 'in_progress',
    in_progress: 'done',
    done: 'todo',
}

const STATUS_COLOR: Record<TaskStatus, string> = {
    todo: '#fff0cc',
    in_progress: '#dde5ff',
    done: '#e0f0e0',
}

const STATUS_LABEL: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    done: 'done ✓',
}

export function TaskItem({ doc }: { doc: LivequeryDocument<DocState<Task>> }) {
    const task = useObservable(doc)

    async function toggleStatus() {
        await doc.update({ status: STATUS_NEXT[task.status] })
    }

    async function remove() {
        await doc.del()
    }

    const isDone = task.status === 'done'

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            background: 'white',
            borderRadius: 6,
            marginBottom: 6,
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            opacity: task._deleting ? 0.4 : 1,
            transition: 'opacity 0.15s',
        }}>
            <input
                type="checkbox"
                checked={isDone}
                onChange={toggleStatus}
                disabled={!!task._updating || !!task._deleting}
                style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
            />
            <span style={{
                flex: 1,
                fontSize: 14,
                textDecoration: isDone ? 'line-through' : 'none',
                color: isDone ? '#999' : '#111',
            }}>
                {task.title}
            </span>
            <button
                onClick={toggleStatus}
                disabled={!!task._updating || !!task._deleting}
                style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    border: 'none',
                    background: STATUS_COLOR[task.status],
                    fontSize: 11,
                    cursor: 'pointer',
                    fontWeight: 600,
                    flexShrink: 0,
                }}
            >
                {STATUS_LABEL[task.status]}
            </button>
            <button
                onClick={remove}
                disabled={!!task._deleting}
                style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}
                title="Xoá"
            >
                ×
            </button>
        </div>
    )
}
