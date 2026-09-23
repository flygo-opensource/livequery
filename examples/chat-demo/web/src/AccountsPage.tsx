import { useState, type FormEvent } from 'react'
import { chat, host } from './service'
import { navigate } from './router'
import { signIn, signOut, useSessions } from './sessions'
import { Avatar, NetworkBar, useAccounts } from './common'

export function AccountsPage() {
    const accounts = useAccounts()
    const sessions = useSessions()
    const [name, setName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const open = (account_id: string) => {
        signIn(account_id)
        navigate(`/accounts/${account_id}`)
    }

    const join = async (e: FormEvent) => {
        e.preventDefault()
        const value = name.trim()
        if (!value) return
        setBusy(true)
        setError(null)
        try {
            const account = await chat.join(value)
            setName('')
            open(account.id)
        } catch (err: any) {
            setError(err?.message ?? String(err))
        } finally {
            setBusy(false)
        }
    }

    const signedIn = accounts.filter(a => sessions.includes(a.id))

    return (
        <main className="page narrow">
            <header className="topbar">
                <h1>Livequery Chat</h1>
                <NetworkBar />
            </header>

            <p className="intro">
                Demo chat local-first: gửi được khi offline, tự đồng bộ khi có mạng, realtime giữa các tài khoản.
                {host === 'shared-worker' ? ' Mọi tab dùng chung một kết nối (SharedWorker).' : ''}
            </p>

            {signedIn.length > 0 && (
                <section className="card">
                    <h2>Đang đăng nhập trên trình duyệt này</h2>
                    <ul className="accounts">
                        {signedIn.map(account => (
                            <li key={account.id}>
                                <button className="account" onClick={() => open(account.id)}>
                                    <Avatar account={account} />
                                    <span>{account.name}</span>
                                </button>
                                <button className="link" onClick={() => signOut(account.id)}>Đăng xuất</button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="card">
                <h2>Tài khoản</h2>
                <p className="hint">Bấm để đăng nhập. Mở tab khác và đăng nhập tài khoản khác để chat với chính mình.</p>
                <ul className="accounts">
                    {accounts.map(account => (
                        <li key={account.id}>
                            <button className="account" onClick={() => open(account.id)}>
                                <Avatar account={account} />
                                <span>{account.name}</span>
                                {sessions.includes(account.id) && <span className="tag">đã đăng nhập</span>}
                            </button>
                        </li>
                    ))}
                    {accounts.length === 0 && <li className="empty">Đang tải…</li>}
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
