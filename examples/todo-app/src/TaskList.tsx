import { useCollection, useObservable } from '@livequery/react'
import type { LivequeryCollection, LivequeryDocument, DocState } from '@livequery/client'
import { AddTask } from './AddTask'
import { TaskItem } from './TaskItem'
import type { Task, TaskStatus } from './types'

type Props = {
    tab: 'all' | TaskStatus
}

export function TaskList({ tab }: Props) {
    // Refs are relative to the api base (/livequery), so 'tasks' → /livequery/tasks
    const ref = tab === 'all' ? 'tasks' : `status/${tab}/tasks`

    const collection = useCollection<Task>(ref, {
        filters: { 'created_at:sort': 'desc' },
    }) as LivequeryCollection<Task>

    const items = useObservable(collection.items)
    const loading = useObservable(collection.loading)
    const error = useObservable(collection.error)

    return (
        <div>
            <AddTask collection={collection} />

            {loading != null && (!items || items.length === 0) && (
                <p style={{ color: '#999', fontSize: 13, textAlign: 'center' }}>Đang tải...</p>
            )}

            {error && (
                <p style={{ color: '#c00', fontSize: 13 }}>Lỗi: {error.message}</p>
            )}

            {loading == null && items && items.length === 0 && !error && (
                <p style={{ color: '#bbb', fontSize: 13, textAlign: 'center' }}>Chưa có task nào.</p>
            )}

            {items && items.map(doc => (
                <TaskItem key={doc.getValue().id} doc={doc as LivequeryDocument<DocState<Task>>} />
            ))}

            {items && items.length > 0 && (
                <p style={{ color: '#bbb', fontSize: 11, textAlign: 'right', marginTop: 8 }}>
                    {items.length} task{items.length > 1 ? 's' : ''} &nbsp;● realtime
                </p>
            )}
        </div>
    )
}
