import { useState, type FormEvent } from 'react'
import { useObservable } from '@livequery/react'
import { host, todos } from './service'
import type { SyncStatus, TodoState } from './TodoService'

type Filter = 'all' | 'open' | 'done'

const LABELS: Record<Filter, string> = { all: 'Tất cả', open: 'Chưa xong', done: 'Đã xong' }

export function App() {
    // Factories: each subscribes once, to a stream coming from the SharedWorker (or this tab).
    const items = useObservable(() => todos.items(), [] as TodoState[])
    const status = useObservable(() => todos.status(), { connected: false, offline: false, pending: 0 } as SyncStatus)
    const [filter, setFilter] = useState<Filter>('all')

    const matches = (item: TodoState, key: Filter) => key === 'all' || (key === 'done') === !!item.done
    const visible = items
        .filter(item => matches(item, filter))
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))

    return (
        <main className="page">
            <header className="header">
                <div>
                    <h1>Todo offline-first</h1>
                    <p className="subtitle">@livequery/client · local-first · IndexedDB · outbox · realtime</p>
                </div>
                <Status status={status} />
            </header>

            <p className={`host ${host}`}>
                {host === 'shared-worker'
                    ? 'SharedWorker: mọi tab dùng chung một client, một WebSocket, một hàng đợi — các tab thấy nhau ngay, kể cả khi offline.'
                    : 'Trình duyệt này không có SharedWorker: mỗi tab có client riêng, đồng bộ với nhau qua server.'}
            </p>

            <label className={`toggle ${status.offline ? 'is-offline' : ''}`}>
                <input type="checkbox" checked={status.offline} onChange={e => todos.setOffline(e.target.checked)} />
                <span>Giả lập mất mạng</span>
                <small>{status.offline
                    ? 'Mọi request HTTP đang bị chặn (áp dụng cho mọi tab)'
                    : 'Bật để thử thêm / sửa / xoá khi offline'}</small>
            </label>

            <AddTodo onAdd={title => todos.add(title)} />

            <nav className="filters">
                {(Object.keys(LABELS) as Filter[]).map(key => (
                    <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
                        {LABELS[key]}
                        <span className="count">{items.filter(item => matches(item, key)).length}</span>
                    </button>
                ))}
            </nav>

            <ul className="list">
                {visible.map(item => <TodoRow key={item.id} todo={item} />)}
                {visible.length === 0 && <li className="empty">Chưa có việc nào.</li>}
            </ul>

            <Guide />
        </main>
    )
}

function Status({ status }: { status: SyncStatus }) {
    const online = status.connected && !status.offline
    return (
        <div className="status">
            <span className={`dot ${online ? 'on' : 'off'}`} />
            <span>{online ? 'Online' : 'Offline'}</span>
            <span className={`badge ${status.pending > 0 ? 'waiting' : 'synced'}`}>
                {status.pending > 0 ? `${status.pending} thay đổi chờ đồng bộ` : 'Đã đồng bộ'}
            </span>
        </div>
    )
}

function AddTodo({ onAdd }: { onAdd: (title: string) => unknown }) {
    const [title, setTitle] = useState('')
    const submit = (e: FormEvent) => {
        e.preventDefault()
        const value = title.trim()
        if (!value) return
        onAdd(value)
        setTitle('')
    }
    return (
        <form className="add" onSubmit={submit}>
            <input value={title} maxLength={200} placeholder="Thêm việc cần làm…" onChange={e => setTitle(e.target.value)} />
            <button type="submit" disabled={!title.trim()}>Thêm</button>
        </form>
    )
}

function TodoRow({ todo }: { todo: TodoState }) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(todo.title)
    const state = describe(todo)

    const save = () => {
        setEditing(false)
        const value = draft.trim()
        if (value && value !== todo.title) todos.update(todo.id, { title: value })
        else setDraft(todo.title)
    }

    return (
        <li className={`row ${todo.done ? 'done' : ''} ${todo._deleting ? 'deleting' : ''}`}>
            <input type="checkbox" checked={!!todo.done} disabled={!!todo._deleting} onChange={() => todos.update(todo.id, { done: !todo.done })} />
            {editing
                ? <input
                    className="edit"
                    autoFocus
                    value={draft}
                    maxLength={200}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={save}
                    onKeyDown={e => {
                        if (e.key === 'Enter') save()
                        if (e.key === 'Escape') { setDraft(todo.title); setEditing(false) }
                    }}
                />
                : <span className="title" title="Nhấp đúp để sửa" onDoubleClick={() => { setDraft(todo.title); setEditing(true) }}>{todo.title}</span>}
            {state && <span className={`tag ${state.kind}`} title={state.hint}>{state.label}</span>}
            <button className="delete" title="Xoá" disabled={!!todo._deleting} onClick={() => todos.remove(todo.id)}>✕</button>
        </li>
    )
}

function describe(todo: TodoState): { kind: string, label: string, hint: string } | null {
    const error = todo._adding_error ?? todo._updating_error ?? todo._deleting_error
    if (error) return { kind: 'error', label: 'Lỗi', hint: `${error.code}: ${error.message}` }
    const action = todo._deleting ? 'xoá' : todo._adding ? 'thêm' : todo._updating ? 'sửa' : null
    if (!action) return null
    if (todo._queued) return { kind: 'queued', label: `Chờ ${action}`, hint: 'Đang nằm trong outbox, sẽ gửi khi có mạng' }
    return { kind: 'sending', label: `Đang ${action}`, hint: 'Đang gửi lên server' }
}

function Guide() {
    return (
        <section className="guide">
            <h2>Thử gì?</h2>
            <ol>
                <li>Mở trang này ở <b>hai tab</b>: thêm / sửa / xoá ở tab này hiện ngay ở tab kia.</li>
                <li>Bật <b>Giả lập mất mạng</b> rồi thao tác ở một tab: tab kia vẫn thấy ngay (chung SharedWorker), các dòng có nhãn <i>Chờ…</i>, badge đếm số thay đổi chờ.</li>
                <li><b>Đóng hết tab rồi mở lại</b> khi vẫn offline: dữ liệu và hàng đợi còn nguyên (IndexedDB).</li>
                <li>Tắt giả lập: hàng đợi tự gửi theo đúng thứ tự, nhãn biến mất.</li>
                <li>Mở trên <b>thiết bị khác</b> (điện thoại): thay đổi đi qua server và hiện realtime ở mọi thiết bị.</li>
                <li>Xung đột: offline sửa tiêu đề một việc, trong lúc đó tick “xong” việc đó trên thiết bị khác. Khi online lại, cả hai thay đổi đều được giữ.</li>
            </ol>
            <p className="note">Mỗi việc nhận id uuidv7 ngay trên trình duyệt; server giữ nguyên id đó, nên gửi lại sau khi mất phản hồi không tạo bản trùng.</p>
        </section>
    )
}
