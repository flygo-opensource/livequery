import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { chat } from './service'
import { Link } from './router'
import { signIn } from './sessions'
import { Avatar, NetworkBar, timeLabel, useAccounts } from './common'
import { useObservable } from '@livequery/react'
import { chatTitle, useInfiniteScroll } from './ChatListPage'
import type { Account, Chat, Message, Page } from './ChatService'

type Delivery = { kind: 'sending' | 'queued' | 'sent' | 'seen' | 'partly-seen' | 'failed', label: string, hint?: string }

export function ChatPage({ account_id, chat_id }: { account_id: string, chat_id: string }) {
    const accounts = useAccounts()
    const me = accounts.find(a => a.id === account_id)
    // The page is keyed by account and chat (main.tsx), so these subscribe once per chat.
    const info = useObservable(() => chat.chat(chat_id), null as Chat | null)
    const page = useObservable(() => chat.messages(chat_id), { items: [], has_more: false, loading: true, error: null } as Page<Message>)

    useEffect(() => signIn(account_id), [account_id])

    // Read receipt: whenever something from someone else is newer than what this account has read.
    const newest_other = page.items.reduce((max, m) => m.sender_id !== account_id && !m._adding ? Math.max(max, m.created_at) : max, 0)
    const read_at = info?.read_at?.[account_id] ?? 0
    const unread = info?.unread?.[account_id] ?? 0
    useEffect(() => {
        if (document.visibilityState !== 'visible') return
        if (unread === 0 && newest_other <= read_at) return
        const timer = setTimeout(() => chat.markRead(chat_id, account_id), 300)
        return () => clearTimeout(timer)
    }, [chat_id, account_id, newest_other, read_at, unread])
    useEffect(() => {
        const onVisible = () => document.visibilityState === 'visible' && chat.markRead(chat_id, account_id)
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [chat_id, account_id])

    // Newest at the bottom: the list is rendered newest-first in a column-reverse container, so
    // loading older messages at the (visual) top never moves what is on screen.
    const sorted = [...page.items].sort((a, b) => b.created_at - a.created_at)
    const top = useInfiniteScroll(() => page.has_more && !page.loading && chat.olderMessages(chat_id), [page.has_more, page.loading, chat_id])
    const members = info?.member_ids.map(id => accounts.find(a => a.id === id)).filter(Boolean) as Account[] | undefined

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

            {page.error && <p className="error slim">Không tải được từ server — đang hiện tin đã lưu. ({page.error})</p>}

            <div className="messages">
                {sorted.map((message, index) => {
                    const older = sorted[index + 1]
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
                                        <button onClick={() => chat.retry(chat_id, message.id)}>Gửi lại</button>
                                        <button className="secondary" onClick={() => chat.discard(chat_id, message.id)}>Xoá</button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
                <div ref={top} className="sentinel">
                    {page.loading ? 'Đang tải…' : page.has_more ? '' : sorted.length > 0 ? 'Đầu cuộc trò chuyện' : 'Chưa có tin nhắn'}
                </div>
            </div>

            <Composer onSend={text => chat.send(chat_id, account_id, text)} />
        </main>
    )
}

function delivery(message: Message & Record<string, any>, info: Chat | null, me: string, accounts: Account[]): Delivery {
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
