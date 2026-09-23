import { UUID, type Db } from 'mongodb'

/** A uuidv7 whose timestamp is `ms`, so seeded ids sort like their `created_at`. */
function uuidv7At(ms: number) {
    const time = ms.toString(16).padStart(12, '0')
    const random = [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join('')
    const variant = ((parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16)
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

const LINES = [
    'Chào bạn 👋', 'Hôm nay thế nào?', 'Ổn, đang làm demo livequery', 'Offline-first chạy ngon chưa?',
    'Ngon, tắt mạng vẫn gửi được', 'Có mạng lại là tự đồng bộ', 'Hay đấy', 'Realtime qua change stream',
    'Tối nay họp nhé', 'Ok', 'Nhớ review PR', 'Đã review', 'Cảm ơn!', 'Cuộn lên để xem tin cũ hơn',
]

/** Seeds mike, bob and alice with a few chats — once, on an empty database. */
export async function seed(db: Db) {
    const accounts = db.collection<any>('accounts')
    if (await accounts.estimatedDocumentCount() > 0) return

    const start = Date.now() - 3 * 24 * 3600 * 1000
    const people = [
        { name: 'mike', color: '#2563eb' },
        { name: 'bob', color: '#16a34a' },
        { name: 'alice', color: '#db2777' },
    ].map((p, i) => ({ ...p, id: uuidv7At(start + i) }))
    await accounts.insertMany(people.map(p => ({
        _id: new UUID(p.id), name: p.name, name_key: p.name, color: p.color, created_at: start,
    })))
    const [mike, bob, alice] = people as [typeof people[0], typeof people[0], typeof people[0]]

    const chats: any[] = []
    const messages: any[] = []
    const addChat = (members: typeof people, count: number, from: number, step: number, title?: string) => {
        const created_at = from - 1000
        const id = uuidv7At(created_at)
        const member_ids = members.map(m => m.id)
        let last: any
        for (let i = 0; i < count; i++) {
            const created = from + i * step
            const sender = members[i % members.length]!
            last = { text: `${LINES[i % LINES.length]} (#${i + 1})`, sender_id: sender.id, created_at: created }
            messages.push({ _id: new UUID(uuidv7At(created)), chat_id: id, ...last })
        }
        const updated_at = last?.created_at ?? created_at
        chats.push({
            _id: new UUID(id),
            type: title ? 'group' : 'direct',
            ...title ? { title } : { member_key: [...member_ids].sort().join(':') },
            member_ids,
            ...last ? { last_message: last } : {},
            // Everyone has read everything seeded.
            read_at: Object.fromEntries(member_ids.map(m => [m, updated_at])),
            unread: Object.fromEntries(member_ids.map(m => [m, 0])),
            updated_at,
            created_at,
        })
    }

    // The long one, for infinite scroll: ~300 messages between mike and bob.
    addChat([mike, bob], 300, start, 12 * 60 * 1000)
    addChat([mike, alice], 12, start + 3600_000, 5 * 60 * 1000)
    addChat([bob, alice], 6, start + 7200_000, 5 * 60 * 1000)
    addChat([mike, bob, alice], 20, start + 10_800_000, 3 * 60 * 1000, 'Team livequery')
    // Enough chats that the conversation list needs to page too.
    for (let i = 1; i <= 25; i++) addChat([mike, bob, alice], 3, start + i * 600_000, 60_000, `Nhóm #${i}`)

    await db.collection('chats').insertMany(chats)
    await db.collection('messages').insertMany(messages)
    console.log(JSON.stringify({ event: 'seeded', accounts: people.length, chats: chats.length, messages: messages.length }))
}
