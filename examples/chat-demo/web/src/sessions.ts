import { useEffect, useState } from 'react'

// Accounts signed in on this browser. The accounts themselves live on the server; this is only
// "which of them this browser uses", shared by every tab through localStorage.
const KEY = 'livequery-chat:sessions'

function read(): string[] {
    try {
        const value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
        return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []
    } catch {
        return []
    }
}

const listeners = new Set<() => void>()

function write(ids: string[]) {
    localStorage.setItem(KEY, JSON.stringify(ids))
    for (const listener of listeners) listener()
}

export function signIn(account_id: string) {
    const ids = read()
    if (!ids.includes(account_id)) write([...ids, account_id])
}

export function signOut(account_id: string) {
    write(read().filter(id => id !== account_id))
}

export function useSessions() {
    const [ids, setIds] = useState(read)
    useEffect(() => {
        const update = () => setIds(read())
        listeners.add(update)
        // Other tabs signing in or out.
        window.addEventListener('storage', update)
        return () => {
            listeners.delete(update)
            window.removeEventListener('storage', update)
        }
    }, [])
    return ids
}
