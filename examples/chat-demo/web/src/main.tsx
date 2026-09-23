import { createRoot } from 'react-dom/client'
import { LivequeryClientProvider } from '@livequery/react'
import { client } from './livequery'
import { match, usePath } from './router'
import { AccountsPage } from './AccountsPage'
import { ChatListPage } from './ChatListPage'
import { ChatPage } from './ChatPage'
import './styles.css'

function App() {
    const route = match(usePath())
    if (route.page === 'chat') return <ChatPage key={`${route.account_id}/${route.chat_id}`} account_id={route.account_id} chat_id={route.chat_id} />
    if (route.page === 'chats') return <ChatListPage key={route.account_id} account_id={route.account_id} />
    return <AccountsPage />
}

// The app shell comes from the service worker, so the app opens without a network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')

// No StrictMode: its dev-only double subscribe would cancel the SharedWorker streams mid-flight.
createRoot(document.getElementById('root')!).render(
    <LivequeryClientProvider core={client}>
        <App />
    </LivequeryClientProvider>,
)
