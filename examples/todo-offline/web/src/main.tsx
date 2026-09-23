import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// No StrictMode: its dev-only double subscribe would cancel the SharedWorker streams mid-flight.
createRoot(document.getElementById('root')!).render(<App />)
