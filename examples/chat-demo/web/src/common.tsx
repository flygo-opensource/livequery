import { chat, host } from './service'
import { useObservable } from '@livequery/react'
import type { Account, SyncStatus } from './ChatService'

export function Avatar({ account, size = 36 }: { account?: Pick<Account, 'name' | 'color'>, size?: number }) {
    const name = account?.name ?? '?'
    return (
        <span className="avatar" style={{ width: size, height: size, background: account?.color ?? '#9ca3af', fontSize: size * 0.42 }}>
            {name.slice(0, 1).toUpperCase()}
        </span>
    )
}

export function useAccounts() {
    return useObservable(() => chat.accounts(), [] as Account[])
}

export function useStatus() {
    return useObservable(() => chat.status(), { connected: false, offline: false, pending: 0 } as SyncStatus)
}

/** Online state, pending count, and the offline switch (shared by every tab through the worker). */
export function NetworkBar() {
    const status = useStatus()
    const online = status.connected && !status.offline
    return (
        <div className={`network ${online ? '' : 'is-offline'}`}>
            <span className={`dot ${online ? 'on' : 'off'}`} />
            <span className="network-label">{online ? 'Online' : 'Offline'}</span>
            {status.pending > 0 && <span className="pending">{status.pending} chờ gửi</span>}
            <label className="switch" title={host === 'shared-worker' ? 'Áp dụng cho mọi tab' : 'Áp dụng cho tab này'}>
                <input type="checkbox" checked={!status.offline} onChange={e => chat.setOffline(!e.target.checked)} />
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
