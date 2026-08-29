export type TaskStatus = 'todo' | 'in_progress' | 'done'

export type Task = {
    id: string
    title: string
    status: TaskStatus
    created_at: number
}
