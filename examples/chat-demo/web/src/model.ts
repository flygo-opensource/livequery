import type { LocalFirstConfig } from '@livequery/client'

export type Account = { id: string, name: string, color: string, created_at: number }

export type Chat = {
    id: string
    type: 'direct' | 'group'
    title?: string
    member_ids: string[]
    last_message?: { text: string, sender_id: string, created_at: number }
    read_at?: Record<string, number>
    unread?: Record<string, number>
    /** Last message: the list order. */
    active_at: number
    created_at: number
}

export type Message = { id: string, chat_id: string, sender_id: string, text: string, created_at: number }

/** An account signed in on this browser. Device-only: never sent to the server. */
export type Session = { id: string, signed_in_at: number }

// What each screen keeps on the device — declared once, synced by the library.

/** Every account: small, needed to sign in and to show names, offline too. */
export const ACCOUNTS: LocalFirstConfig = { scope: 'full', keep: 'always', sort: { name: 'asc' } }

/** A chat's messages: the newest 200 on the device, older pages fetched when scrolled to. */
export const MESSAGES: LocalFirstConfig = { scope: 'window', size: 200, sort: { created_at: 'desc' } }

/**
 * All my chats, and for each one its newest messages — so any chat opens offline, even one never
 * opened on this device. Kept in sync in the background while the app runs.
 */
export const CHATS: LocalFirstConfig = {
    scope: 'full',
    keep: 'always',
    sort: { active_at: 'desc' },
    children: { 'chats/:id/messages': MESSAGES },
}
