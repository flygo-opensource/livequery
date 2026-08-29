import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LivequeryClientProvider } from '@livequery/react'
import { App } from './App'
import { client } from './client'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <LivequeryClientProvider core={client}>
            <App />
        </LivequeryClientProvider>
    </StrictMode>
)
