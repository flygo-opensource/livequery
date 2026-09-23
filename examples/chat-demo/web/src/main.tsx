import { createRoot } from 'react-dom/client'
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

// No StrictMode: its dev-only double subscribe would cancel the SharedWorker streams mid-flight.
createRoot(document.getElementById('root')!).render(<App />)
