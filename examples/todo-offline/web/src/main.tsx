import { createRoot } from 'react-dom/client'
import { LivequeryClientProvider } from '@livequery/react'
import { client } from './livequery'
import { App } from './App'
import './styles.css'

// The app shell comes from the service worker, so the app opens without a network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')

// No StrictMode: its dev-only double subscribe would cancel the SharedWorker streams mid-flight.
createRoot(document.getElementById('root')!).render(
    <LivequeryClientProvider core={client}>
        <App />
    </LivequeryClientProvider>,
)
