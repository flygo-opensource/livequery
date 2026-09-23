import { useCollection, useDocument } from '@livequery/react'
import type { LivequeryStatus } from '@livequery/client'
import { host } from './livequery'
import { ACCOUNTS, type Account, type Session } from './model'

export function Avatar({ account, size = 36 }: { account?: Pick<Account, 'name' | 'color'>, size?: number }) {
    const name = account?.name ?? '?'
    return (
        <span className="avatar" style={{ width: size, height: size, background: account?.color ?? '#9ca3af', fontSize: size * 0.42 }}>
            {name.slice(0, 1).toUpperCase()}
        </span>
    )
}

/** Every account, synced whole: the list and name lookups work offline. */
export function useAccounts() {
    const accounts = useCollection<Account>('accounts', { mode: ACCOUNTS, filters: { 'name:sort': 'asc' } as any, ssr: false })
    return { accounts, list: accounts.items.value.map(item => item.value as Account) }
}

/** Accounts signed in on this browser — a device-only collection shared by every tab. */
export function useSessions() {
    const sessions = useCollection<Session>('sessions', { mode: 'local-only', ssr: false })
    const ids = sessions.items.value.map(item => item.value.id)
    const signIn = (account_id: string) => {
        if (!ids.includes(account_id)) sessions.add({ id: account_id, signed_in_at: Date.now() })
    }
    const signOut = (account_id: string) => sessions.delete(account_id)
    return { ids, signIn, signOut }
}

/** Online state, writes waiting to be sent, and the offline switch — from the library's status document. */
export function NetworkBar() {
    const [status] = useDocument<LivequeryStatus & { id: string }>('livequery/status')
    const value = status?.value
    const online = !!value?.online
    return (
        <div className={`network ${online ? '' : 'is-offline'}`}>
            <span className={`dot ${online ? 'on' : 'off'}`} />
            <span className="network-label">{online ? 'Online' : 'Offline'}</span>
            {!!value?.pending && <span className="pending">{value.pending} chờ gửi</span>}
            <label className="switch" title={host === 'shared-worker' ? 'Giả lập mất mạng — áp dụng cho mọi tab' : 'Giả lập mất mạng — áp dụng cho tab này'}>
                <input type="checkbox" checked={!value?.offline} onChange={e => status?.update({ offline: !e.target.checked })} />
                <span className="slider" />
            </label>
        </div>
    )
}

export function timeLabel(ms: number) {
    const date = new Date(ms)
    const now = new Date()
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

export function errorText(error: unknown) {
    const e = error as { code?: string, message?: string } | null
    if (e?.code === 'NETWORK_ERROR') return 'Cần có mạng để làm việc này'
    return e?.message ?? String(error)
}
