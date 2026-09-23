import { useEffect, useRef, useState } from 'react'
import { useCollection } from '@livequery/react'
import type { LivequeryCollection } from '@livequery/client'
import { Link, navigate } from './router'
import { Avatar, NetworkBar, errorText, timeLabel, useAccounts, useSessions } from './common'
import { CHATS, type Account, type Chat } from './model'

export function chatTitle(item: Pick<Chat, 'type' | 'title' | 'member_ids'>, me: string, accounts: Account[]) {
    if (item.title) return item.title
    const others = item.member_ids.filter(id => id !== me).map(id => accounts.find(a => a.id === id)?.name ?? '…')
    return others.join(', ') || 'Chỉ mình bạn'
}

/** My chats, most recent first. Every page of the app declares the same mode for this ref. */
export function useChats(account_id: string) {
    return useCollection<Chat>(`accounts/${account_id}/chats`, {
        mode: CHATS,
        filters: { ':limit': 30, 'active_at:sort': 'desc' } as any,
        ssr: false,
    })
}

export function ChatListPage({ account_id }: { account_id: string }) {
    const { list: accounts } = useAccounts()
    const sessions = useSessions()
    const chats = useChats(account_id)
    const me = accounts.find(a => a.id === account_id)
    const items = chats.items.value.map(item => item.value as Chat)
    const loading = chats.loading.value !== null
    const has_more = !!chats.paging.value.next
    const [creating, setCreating] = useState(false)

    // Opening an account's URL signs it in on this browser (a demo: no password).
    const signed_in = sessions.ids.includes(account_id)
    useEffect(() => { !signed_in && sessions.signIn(account_id) }, [signed_in, account_id])

    const sentinel = useInfiniteScroll(() => has_more && !loading && chats.loadMore(), [has_more, loading, chats])

    return (
        <main className="page narrow">
            <header className="topbar">
                <Link to="/accounts" className="back">←</Link>
                <Avatar account={me} />
                <div className="who">
                    <strong>{me?.name ?? '…'}</strong>
                    <AccountSwitcher current={account_id} sessions={sessions.ids} accounts={accounts} />
                </div>
                <NetworkBar />
            </header>

            <div className="toolbar">
                <h2>Hội thoại</h2>
                <button onClick={() => setCreating(true)}>+ Chat mới</button>
            </div>

            {chats.error.value && items.length === 0 && <p className="error">Không tải được từ server. ({errorText(chats.error.value)})</p>}

            <ul className="chats">
                {items.map(item => <ChatRow key={item.id} item={item} me={account_id} accounts={accounts} />)}
                {!loading && items.length === 0 && <li className="empty">Chưa có hội thoại nào.</li>}
                <li ref={sentinel} className="sentinel">{loading ? 'Đang tải…' : has_more ? '' : items.length > 0 ? 'Hết' : ''}</li>
            </ul>

            {creating && <NewChat me={account_id} accounts={accounts} chats={chats} onClose={() => setCreating(false)} />}
        </main>
    )
}

function ChatRow({ item, me, accounts }: { item: Chat & Record<string, any>, me: string, accounts: Account[] }) {
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
                    <span className="chat-last">
                        {item._adding_error ? `⚠ ${item._adding_error.message}`
                            : item._adding ? '🕓 Chờ tạo trên server'
                                : last ? `${sender ? `${sender}: ` : ''}${last.text}` : 'Chưa có tin nhắn'}
                    </span>
                </span>
                <span className="chat-meta">
                    <span className="time">{timeLabel(item.active_at)}</span>
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

function NewChat({ me, accounts, chats, onClose }: { me: string, accounts: Account[], chats: LivequeryCollection<Chat>, onClose: () => void }) {
    const [picked, setPicked] = useState<string[]>([])
    const [title, setTitle] = useState('')
    const [error, setError] = useState<string | null>(null)
    const others = accounts.filter(a => a.id !== me)
    const group = picked.length > 1

    const create = async () => {
        setError(null)
        const member_ids = [me, ...picked]
        // A direct chat exists once: open the one already on this device.
        if (!group) {
            const existing = chats.items.value.map(i => i.value as Chat)
                .find(c => c.type === 'direct' && c.member_ids.length === 2 && member_ids.every(id => c.member_ids.includes(id)))
            if (existing) {
                onClose()
                return navigate(`/accounts/${me}/chats/${existing.id}`)
            }
        }
        const now = Date.now()
        try {
            // Local-first: the chat exists on this device at once and is created on the server when
            // there is a network; messages written to it meanwhile wait behind it in the outbox.
            const created = await chats.add({
                type: group ? 'group' : 'direct',
                ...group ? { title: title.trim() || 'Nhóm mới' } : {},
                member_ids,
                read_at: Object.fromEntries(member_ids.map(id => [id, now])),
                unread: Object.fromEntries(member_ids.map(id => [id, 0])),
                active_at: now,
                created_at: now,
            })
            onClose()
            navigate(`/accounts/${me}/chats/${created.id}`)
        } catch (err) {
            setError(errorText(err))
        }
    }

    return (
        <div className="dialog-backdrop" onClick={onClose}>
            <div className="dialog" onClick={e => e.stopPropagation()}>
                <h3>Chat mới</h3>
                <p className="hint">Chọn một người để chat 1-1, nhiều người để tạo nhóm. Tạo được cả khi offline.</p>
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
                    <button disabled={picked.length === 0} onClick={create}>{group ? 'Tạo nhóm' : 'Mở chat'}</button>
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
