import { useState } from 'react'
import { TaskList } from './TaskList'
import type { TaskStatus } from './types'

type Tab = 'all' | TaskStatus

const TABS: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'todo', label: 'Todo' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
]

export function App() {
    const [tab, setTab] = useState<Tab>('all')

    return (
        <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#3b4a6b', marginBottom: 20 }}>
                Tasks
            </h1>

            <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
                {TABS.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        style={{
                            padding: '6px 14px',
                            borderRadius: 20,
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 13,
                            fontWeight: tab === t.key ? 700 : 400,
                            background: tab === t.key ? '#3b4a6b' : '#eee',
                            color: tab === t.key ? 'white' : '#555',
                        }}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            <TaskList tab={tab} />
        </div>
    )
}
