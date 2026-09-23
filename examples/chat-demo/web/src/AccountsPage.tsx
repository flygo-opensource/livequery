import { useState, type FormEvent } from 'react'
import { host } from './livequery'
import { navigate } from './router'
import { Avatar, NetworkBar, errorText, useAccounts, useSessions } from './common'

export function AccountsPage() {
    const { accounts, list } = useAccounts()
    const sessions = useSessions()
    const [name, setName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const open = (account_id: string) => {
        sessions.signIn(account_id)
        navigate(`/accounts/${account_id}`)
    }

    const join = async (e: FormEvent) => {
        e.preventDefault()
        const value = name.trim()
        if (!value) return
        // A name already on the list signs into that account — no password, it is a demo.
        const existing = list.find(a => a.name.toLowerCase() === value.toLowerCase())
        if (existing) return open(existing.id)
        setBusy(true)
        setError(null)
        try {
            // A new account needs the server (names are unique), so this one is not queued offline.
            const account = await accounts.add({ name: value }, 'server-first')
            setName('')
            open(account.id)
        } catch (err) {
            setError(errorText(err))
        } finally {
            setBusy(false)
        }
    }

    const signed_in = list.filter(a => sessions.ids.includes(a.id))

    return (
        <main className="page narrow">
            <header className="topbar">
                <h1>Livequery Chat</h1>
                <NetworkBar />
            </header>

            <p className="intro">
                Demo chat local-first (PWA): cài lên máy, mở được khi mất mạng, tin nhắn gửi lúc offline tự đi khi có mạng lại.
                {host === 'shared-worker' ? ' Mọi tab dùng chung một kết nối (SharedWorker).' : ''}
            </p>

            {signed_in.length > 0 && (
                <section className="card">
                    <h2>Đang đăng nhập trên trình duyệt này</h2>
                    <ul className="accounts">
                        {signed_in.map(account => (
                            <li key={account.id}>
                                <button className="account" onClick={() => open(account.id)}>
                                    <Avatar account={account} />
                                    <span>{account.name}</span>
                                </button>
                                <button className="link" onClick={() => sessions.signOut(account.id)}>Đăng xuất</button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="card">
                <h2>Tài khoản</h2>
                <p className="hint">Bấm để đăng nhập. Mở tab khác và đăng nhập tài khoản khác để chat với chính mình.</p>
                <ul className="accounts">
                    {list.map(account => (
                        <li key={account.id}>
                            <button className="account" onClick={() => open(account.id)}>
                                <Avatar account={account} />
                                <span>{account.name}</span>
                                {sessions.ids.includes(account.id) && <span className="tag">đã đăng nhập</span>}
                            </button>
                        </li>
                    ))}
                    {list.length === 0 && <li className="empty">{accounts.loading.value ? 'Đang tải…' : 'Chưa có tài khoản nào.'}</li>}
                </ul>

                <form className="join" onSubmit={join}>
                    <input value={name} maxLength={32} placeholder="Nhập tên để tham gia…" onChange={e => setName(e.target.value)} />
                    <button type="submit" disabled={busy || !name.trim()}>Tham gia</button>
                </form>
                {error && <p className="error">{error}</p>}
            </section>
        </main>
    )
}
