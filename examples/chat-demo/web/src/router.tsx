import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

const listeners = new Set<() => void>()

export function navigate(path: string, replace = false) {
    if (replace) history.replaceState(null, '', path)
    else history.pushState(null, '', path)
    for (const listener of listeners) listener()
}

export function usePath() {
    const [path, setPath] = useState(window.location.pathname)
    useEffect(() => {
        const update = () => setPath(window.location.pathname)
        listeners.add(update)
        window.addEventListener('popstate', update)
        return () => {
            listeners.delete(update)
            window.removeEventListener('popstate', update)
        }
    }, [])
    return path
}

export type Route =
    | { page: 'accounts' }
    | { page: 'chats', account_id: string }
    | { page: 'chat', account_id: string, chat_id: string }

export function match(path: string): Route {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] === 'accounts' && parts[1] && parts[2] === 'chats' && parts[3]) {
        return { page: 'chat', account_id: parts[1], chat_id: parts[3] }
    }
    if (parts[0] === 'accounts' && parts[1]) return { page: 'chats', account_id: parts[1] }
    return { page: 'accounts' }
}

export function Link({ to, children, className }: { to: string, children: ReactNode, className?: string }) {
    const click = (e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
    }
    return <a href={to} className={className} onClick={click}>{children}</a>
}
