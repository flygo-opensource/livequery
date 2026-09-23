import { useEffect, useRef, useState } from 'react'
import { chat } from './service'
import { Link, navigate } from './router'
import { signIn, useSessions } from './sessions'
import { Avatar, NetworkBar, timeLabel, useAccounts } from './common'
import { useObservable } from '@livequery/react'
import type { Account, Chat, Page } from './ChatService'

export function chatTitle(item: Pick<Chat, 'type' | 'title' | 'member_ids'>, me: string, accounts: Account[]) {
    if (item.title) return item.title
    const others = item.member_ids.filter(id => id !== me).map(id => accounts.find(a => a.id === id)?.name ?? '…')
    return others.join(', ') || 'Chỉ mình bạn'
}

export function ChatListPage({ account_id }: { account_id: string }) {
    const accounts = useAccounts()
    const sessions = useSessions()
    const me = accounts.find(a => a.id === account_id)
    // The page is keyed by account_id (main.tsx), so this subscribes once per account.
    const page = useObservable(() => chat.chats(account_id), { items: [], has_more: false, loading: true, error: null } as Page<Chat>)
    const [creating, setCreating] = useState(false)

    // Opening an account's URL signs it in on this browser (a demo: no password).
    useEffect(() => signIn(account_id), [account_id])

    const sentinel = useInfiniteScroll(() => page.has_more && !page.loading && chat.moreChats(account_id), [page.has_more, page.loading, account_id])

    return (
        <main className="page narrow">
            <header className="topbar">
                <Link to="/accounts" className="back">←</Link>
                <Avatar account={me} />
                <div className="who">
                    <strong>{me?.name ?? '…'}</strong>
                    <AccountSwitcher current={account_id} sessions={sessions} accounts={accounts} />
                </div>
                <NetworkBar />
            </header>

            <div className="toolbar">
                <h2>Hội thoại</h2>
                <button onClick={() => setCreating(true)}>+ Chat mới</button>
            </div>

            {page.error && <p className="error">Không tải được từ server — đang hiện dữ liệu đã lưu. ({page.error})</p>}

            <ul className="chats">
                {[...page.items].sort((a, b) => b.updated_at - a.updated_at).map(item => (
                    <ChatRow key={item.id} item={item} me={account_id} accounts={accounts} />
                ))}
                {!page.loading && page.items.length === 0 && <li className="empty">Chưa có hội thoại nào.</li>}
                <li ref={sentinel} className="sentinel">{page.loading ? 'Đang tải…' : page.has_more ? '' : page.items.length > 0 ? 'Hết' : ''}</li>
            </ul>

            {creating && <NewChat me={account_id} accounts={accounts} onClose={() => setCreating(false)} />}
        </main>
    )
}

function ChatRow({ item, me, accounts }: { item: Chat, me: string, accounts: Account[] }) {
    const unread = item.unread?.[me] ?? 0
    const last = item.last_message
    const sender = last && (last.sender_id === me ? 'Bạn' : accounts.find(a => a.id === last.sender_id)?.name)
    const other = item.type === 'direct' ? accounts.find(a => a.id === item.member_ids.find(id => id !== me)) : undefined
    return (
        <li>
            <Link to={`/accounts/${me}/chats/${item.id}`} className={`chat-row ${unread > 0 ? 'unread' : ''}`}>
                {other ? <Avatar account={other} size={42} /> : <span className="avatar group" style={{ width: 42, height: 42 }}>{item.member_ids.length}</span>}
                <span className="chat-main">
                    <span className="chat-title">{chatTitle(item, me, accounts)}</span>
                    <span className="chat-last">{last ? `${sender ? `${sender}: ` : ''}${last.text}` : 'Chưa có tin nhắn'}</span>
                </span>
                <span className="chat-meta">
                    <span className="time">{timeLabel(item.updated_at)}</span>
                    {unread > 0 && <span className="unread-badge">{unread}</span>}
                </span>
            </Link>
        </li>
    )
}

function AccountSwitcher({ current, sessions, accounts }: { current: string, sessions: string[], accounts: Account[] }) {
    const others = accounts.filter(a => sessions.includes(a.id) && a.id !== current)
    if (others.length === 0) return <span className="muted">Đổi tài khoản ở trang đầu</span>
    return (
        <span className="switcher">
            Chuyển:{' '}
            {others.map(a => <Link key={a.id} to={`/accounts/${a.id}`}>{a.name}</Link>)}
        </span>
    )
}

function NewChat({ me, accounts, onClose }: { me: string, accounts: Account[], onClose: () => void }) {
    const [picked, setPicked] = useState<string[]>([])
    const [title, setTitle] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const others = accounts.filter(a => a.id !== me)
    const group = picked.length > 1

    const create = async () => {
        setBusy(true)
        setError(null)
        try {
            const created = await chat.createChat([me, ...picked], group ? title.trim() || 'Nhóm mới' : undefined)
            onClose()
            navigate(`/accounts/${me}/chats/${created.id}`)
        } catch (err: any) {
            setError(err?.message ?? String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="dialog-backdrop" onClick={onClose}>
            <div className="dialog" onClick={e => e.stopPropagation()}>
                <h3>Chat mới</h3>
                <p className="hint">Chọn một người để chat 1-1, nhiều người để tạo nhóm.</p>
                <ul className="pick">
                    {others.map(a => (
                        <li key={a.id}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={picked.includes(a.id)}
                                    onChange={e => setPicked(e.target.checked ? [...picked, a.id] : picked.filter(id => id !== a.id))}
                                />
                                <Avatar account={a} size={28} />
                                {a.name}
                            </label>
                        </li>
                    ))}
                </ul>
                {group && <input className="group-title" value={title} maxLength={64} placeholder="Tên nhóm" onChange={e => setTitle(e.target.value)} />}
                {error && <p className="error">{error}</p>}
                <div className="dialog-actions">
                    <button className="secondary" onClick={onClose}>Huỷ</button>
                    <button disabled={busy || picked.length === 0} onClick={create}>{group ? 'Tạo nhóm' : 'Mở chat'}</button>
                </div>
            </div>
        </div>
    )
}

/** A ref for an element that calls `load` whenever it scrolls into view. */
export function useInfiniteScroll(load: () => unknown, deps: unknown[]) {
    const ref = useRef<HTMLLIElement | HTMLDivElement | null>(null)
    useEffect(() => {
        const element = ref.current
        if (!element) return
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) load()
        }, { rootMargin: '200px' })
        observer.observe(element)
        return () => observer.disconnect()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return ref as any
}
