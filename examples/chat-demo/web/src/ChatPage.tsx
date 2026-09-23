import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useCollection, useDocument } from '@livequery/react'
import { Link } from './router'
import { Avatar, NetworkBar, errorText, timeLabel, useAccounts, useSessions } from './common'
import { chatTitle, useInfiniteScroll } from './ChatListPage'
import { CHATS, MESSAGES, type Account, type Chat, type Message } from './model'

type Delivery = { kind: 'sending' | 'queued' | 'sent' | 'seen' | 'partly-seen' | 'failed', label: string, hint?: string }

export function ChatPage({ account_id, chat_id }: { account_id: string, chat_id: string }) {
    const { list: accounts } = useAccounts()
    const sessions = useSessions()
    const me = accounts.find(a => a.id === account_id)
    // The chat as one of mine: synced with my chat list, so it is here offline too.
    const [chat_doc] = useDocument<Chat>(`accounts/${account_id}/chats/${chat_id}`, { mode: CHATS, ssr: false })
    const info = chat_doc?.value as (Chat & Record<string, any>) | undefined
    const messages = useCollection<Message>(`chats/${chat_id}/messages`, {
        mode: MESSAGES,
        filters: { ':limit': 30, 'created_at:sort': 'desc' } as any,
        ssr: false,
    })
    const items = messages.items.value.map(item => item.value as Message & Record<string, any>)
    const loading = messages.loading.value !== null
    const has_more = !!messages.paging.value.next

    const signed_in = sessions.ids.includes(account_id)
    useEffect(() => { !signed_in && sessions.signIn(account_id) }, [signed_in, account_id])

    // Read receipt: whenever something from someone else is newer than what this account has read.
    // Needs the network; when offline the next change after reconnecting sends it.
    const newest_other = items.reduce((max, m) => m.sender_id !== account_id && !m._adding ? Math.max(max, m.created_at) : max, 0)
    const read_at = info?.read_at?.[account_id] ?? 0
    const unread = info?.unread?.[account_id] ?? 0
    useEffect(() => {
        if (!chat_doc || info?._adding) return
        if (document.visibilityState !== 'visible') return
        if (unread === 0 && newest_other <= read_at) return
        const timer = setTimeout(() => Promise.resolve(chat_doc.trigger('read')).catch(() => undefined), 300)
        return () => clearTimeout(timer)
    }, [chat_doc, newest_other, read_at, unread, info?._adding])

    // Newest at the bottom: the list is rendered newest-first in a column-reverse container, so
    // loading older messages at the (visual) top never moves what is on screen.
    const top = useInfiniteScroll(() => has_more && !loading && messages.loadMore(), [has_more, loading, messages])
    const members = info?.member_ids.map(id => accounts.find(a => a.id === id)).filter(Boolean) as Account[] | undefined

    const send = (text: string) => messages.add({ sender_id: account_id, text, created_at: Date.now() })

    return (
        <main className="page chat-page">
            <header className="topbar">
                <Link to={`/accounts/${account_id}`} className="back">←</Link>
                <div className="who">
                    <strong>{info ? chatTitle(info, account_id, accounts) : '…'}</strong>
                    <span className="muted">
                        {members ? members.map(m => m.id === account_id ? 'bạn' : m.name).join(', ') : ''}
                        {me ? ` · đang dùng: ${me.name}` : ''}
                    </span>
                </div>
                <NetworkBar />
            </header>

            {messages.error.value && items.length === 0 && <p className="error slim">Không tải được tin nhắn. ({errorText(messages.error.value)})</p>}

            <div className="messages">
                {items.map((message, index) => {
                    const older = items[index + 1]
                    const mine = message.sender_id === account_id
                    const sender = accounts.find(a => a.id === message.sender_id)
                    const first_of_run = !older || older.sender_id !== message.sender_id
                    return (
                        <div key={message.id} className={`bubble-row ${mine ? 'mine' : ''}`}>
                            {!mine && <span className="bubble-avatar">{first_of_run ? <Avatar account={sender} size={28} /> : null}</span>}
                            <div className="bubble-wrap">
                                {!mine && first_of_run && info?.type === 'group' && <span className="bubble-sender">{sender?.name}</span>}
                                <div className={`bubble ${message._adding_error ? 'failed' : ''}`}>
                                    <span className="bubble-text">{message.text}</span>
                                    <span className="bubble-meta">
                                        {timeLabel(message.created_at)}
                                        {mine && <DeliveryMark delivery={delivery(message, info, account_id, accounts)} />}
                                    </span>
                                </div>
                                {mine && message._adding_error && (
                                    <div className="failed-actions">
                                        <span>{message._adding_error.message}</span>
                                        <button onClick={() => messages.retry(message.id)}>Gửi lại</button>
                                        <button className="secondary" onClick={() => messages.delete(message.id)}>Xoá</button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
                <div ref={top} className="sentinel">
                    {loading ? 'Đang tải…' : has_more ? '' : items.length > 0 ? 'Đầu cuộc trò chuyện' : 'Chưa có tin nhắn'}
                </div>
            </div>

            <Composer onSend={send} />
        </main>
    )
}

function delivery(message: Message & Record<string, any>, info: Chat | undefined, me: string, accounts: Account[]): Delivery {
    if (message._adding_error) return { kind: 'failed', label: '⚠ Gửi lỗi', hint: message._adding_error.message }
    if (message._queued) return { kind: 'queued', label: '🕓 Chờ gửi', hint: 'Đang offline — sẽ tự gửi khi có mạng' }
    if (message._adding) return { kind: 'sending', label: '⏳ Đang gửi' }
    const others = (info?.member_ids ?? []).filter(id => id !== me)
    const seen_by = others.filter(id => (info?.read_at?.[id] ?? 0) >= message.created_at)
    const names = seen_by.map(id => accounts.find(a => a.id === id)?.name ?? '…').join(', ')
    if (others.length > 0 && seen_by.length === others.length) return { kind: 'seen', label: '✓✓ Đã xem', hint: `Đã xem: ${names}` }
    if (seen_by.length > 0) return { kind: 'partly-seen', label: `✓✓ ${seen_by.length}/${others.length}`, hint: `Đã xem: ${names}` }
    return { kind: 'sent', label: '✓ Đã gửi' }
}

function DeliveryMark({ delivery }: { delivery: Delivery }) {
    return <span className={`delivery ${delivery.kind}`} title={delivery.hint}>{delivery.label}</span>
}

function Composer({ onSend }: { onSend: (text: string) => unknown }) {
    const [text, setText] = useState('')
    const send = (e?: FormEvent) => {
        e?.preventDefault()
        const value = text.trim()
        if (!value) return
        onSend(value)
        setText('')
    }
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
        }
    }
    return (
        <form className="composer" onSubmit={send}>
            <textarea
                rows={1}
                value={text}
                maxLength={2000}
                placeholder="Nhắn tin… (gõ /fail … để thử gửi lỗi)"
                onChange={e => setText(e.target.value)}
                onKeyDown={onKey}
            />
            <button type="submit" disabled={!text.trim()}>Gửi</button>
        </form>
    )
}
