import { useState } from 'react'
import type { LivequeryCollection } from '@livequery/client'
import type { Task } from './types'

export function AddTask({ collection }: { collection: LivequeryCollection<Task> }) {
    const [title, setTitle] = useState('')
    const [loading, setLoading] = useState(false)

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        const t = title.trim()
        if (!t) return
        setLoading(true)
        try {
            await collection.add({ title: t, status: 'todo', created_at: Date.now() })
            setTitle('')
        } finally {
            setLoading(false)
        }
    }

    return (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Thêm task mới..."
                disabled={loading}
                style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 14 }}
            />
            <button
                type="submit"
                disabled={loading || !title.trim()}
                style={{ padding: '8px 16px', borderRadius: 6, background: '#3b4a6b', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14 }}
            >
                {loading ? '...' : 'Thêm'}
            </button>
        </form>
    )
}
