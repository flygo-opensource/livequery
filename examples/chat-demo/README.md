# Chat demo

Demo chat local-first (PWA) dựng trên livequery, đang chạy tại **https://livequery-chat.global.flygo.vn**.

- **Chạy khi mất mạng**: cài được như app (manifest + service worker giữ app shell); mở lại, tải lại
  trang khi không có mạng vẫn thấy mọi hội thoại và tin nhắn — kể cả hội thoại chưa từng mở trên máy.
- **Có mạng lại thì tự đồng bộ**: tin gửi lúc offline nằm trong outbox (còn nguyên sau khi tải lại
  trang) và tự gửi; phần đã lỡ được lấy bằng delta (`updated_at` + tombstone), không tải lại hết.
- **React chỉ dùng `useCollection` và `useDocument`** — không service riêng, không `useObservable`.

```text
tab 1 (mike) ─┐                           SharedWorker (một cho mọi tab, mọi tài khoản)
tab 2 (bob)  ─┼── createRemoteLivequeryClient ──▶ LivequeryClient · IndexedDB · outbox · 1 WebSocket
tab n        ─┘   (@livequery/rpc)                LivequerySync: giữ trên máy đúng phần đã khai báo
                                                        │
service worker: app shell (precache mọi file của bản build)      ▼
                                    server.ts (Bun): Hono + MongoDatasource (sync: true) + change stream
```

## Khai báo, không viết code đồng bộ

Mọi thứ nằm ở `mode` của collection (`web/src/model.ts`); thư viện tự tải, giữ, đồng bộ:

```ts
// Mọi tài khoản: nhỏ, cần để đăng nhập và hiện tên — cả khi offline.
const ACCOUNTS = { scope: 'full', keep: 'always', sort: { name: 'asc' } }
// Tin nhắn một hội thoại: 200 tin mới nhất trên máy, cuộn quá thì tải thêm.
const MESSAGES = { scope: 'window', size: 200, sort: { created_at: 'desc' } }
// Mọi hội thoại của tôi, và với mỗi hội thoại là các tin mới nhất của nó.
const CHATS = { scope: 'full', keep: 'always', sort: { active_at: 'desc' }, children: { 'chats/:id/messages': MESSAGES } }
```

| Dữ liệu | Hook |
| --- | --- |
| Tài khoản | `useCollection('accounts', { mode: ACCOUNTS })` |
| Tài khoản đăng nhập trên trình duyệt này | `useCollection('sessions', { mode: 'local-only' })` — chỉ ở máy, chung mọi tab |
| Hội thoại của tôi | `useCollection('accounts/:me/chats', { mode: CHATS })` |
| Một hội thoại (tiêu đề, thành viên, đã xem) | `useDocument('accounts/:me/chats/:id', { mode: CHATS })` |
| Tin nhắn | `useCollection('chats/:id/messages', { mode: MESSAGES })` |
| Online / offline / số tin chờ gửi | `useDocument('livequery/status')` — cập nhật `{ offline: true }` để giả lập mất mạng |

Ghi: `accounts.add({ name }, 'server-first')` (tên mới cần server), `chats.add(...)` và
`messages.add(...)` (local-first — tạo được khi offline, tin nhắn vào hội thoại mới xếp sau nó trong
outbox), `messages.retry(id)`, `messages.delete(id)`, `chat.trigger('read')`.

## Trang

| Đường dẫn | Nội dung |
| --- | --- |
| `/accounts` | Tài khoản (seed: mike, bob, alice). Bấm để đăng nhập; nhập tên có sẵn thì vào tài khoản đó, tên mới thì tạo trên server. Nhiều tài khoản đăng nhập cùng lúc trên một trình duyệt |
| `/accounts/:account_id` | Hội thoại, mới nhất trên đầu, 30/trang từ máy, số tin chưa đọc, tạo chat 1-1 hoặc nhóm (cả khi offline) |
| `/accounts/:account_id/chats/:chat_id` | Tin nhắn, mới nhất dưới cùng, cuộn lên để xem tin cũ (quá 200 tin trên máy thì tải từ server), trạng thái gửi |

## Trạng thái tin nhắn

| | Khi nào | Nguồn |
| --- | --- | --- |
| ⏳ Đang gửi | Đang trên đường lên server | `_adding` |
| 🕓 Chờ gửi | Offline, nằm trong outbox; tự gửi khi có mạng | `_queued` |
| ✓ Đã gửi | Server đã nhận | không còn cờ |
| ✓✓ Đã xem / ✓✓ 1/2 | Mọi (hoặc một số) thành viên khác đã mở hội thoại | `read_at` của chat trên server |
| ⚠ Gửi lỗi | Server từ chối — gõ tin bắt đầu bằng `/fail` để thử; có nút **Gửi lại** / **Xoá** | `_adding_error`, `collection.retry()` |

## Dữ liệu (MongoDB `livequery_chat_demo`)

- `accounts { _id: UUID, name, name_key (unique), color, created_at, updated_at }`
- `chats { _id: UUID (id do máy tạo), type: direct|group, title?, member_ids[], member_key? (chat 1-1 không trùng), last_message, read_at{account: ts}, unread{account: n}, active_at, updated_at }`
- `messages { _id: UUID (id do máy tạo), chat_id, sender_id, text, created_at, updated_at }`

Mọi route đọc dùng `mongodb({ sync: true })`: mỗi lần ghi đặt `updated_at`, xoá là tombstone
`deleted_at`, và máy offline lâu chỉ hỏi "đã đổi gì từ `updated_at` X". Danh sách hội thoại xếp theo
`active_at` (tin cuối), không theo `updated_at`, để đánh dấu đã đọc không đảo thứ tự. Gửi tin xong
server cập nhật `last_message`, `active_at`, `unread`; mở hội thoại gọi
`POST /livequery/accounts/:me/chats/:id/~read`.

Realtime từ change stream: `accounts`, `accounts/:member_ids/chats` (chia theo mảng thành viên) và
`chats/:chat_id/messages`.

Demo không có mật khẩu: ai biết tên đều vào được tài khoản đó. Server giới hạn 500 tài khoản,
2000 hội thoại, 50 000 tin.

## Chạy, build, deploy

```bash
MONGO_URL='mongodb://127.0.0.1:27017/?directConnection=true' bun examples/chat-demo/server.ts
bun run --cwd examples/chat-demo dev:web            # dev server, proxy tới :8091 (không có service worker)

cd examples/chat-demo
bunx vite build && bun build server.ts --target=bun --outdir=dist-server   # vite build sinh luôn dist/sw.js
```

Trên `192.168.2.4`: `~/apps/livequery-chat` (`dist/`, `dist-server/`, `.env` quyền 600 với user
MongoDB `livequery_chat` chỉ có quyền trên `livequery_chat_demo`), container `livequery-chat`
(`oven/bun:1.3`, `--network host`, cổng 8091), publish qua NetBird (`livequery-chat`). Sau khi thay
`dist/` phải `docker restart livequery-chat`.

## Kiểm tra

```bash
bun examples/chat-demo/browser-check.ts https://livequery-chat.global.flygo.vn
```

Chrome headless, 45 kiểm tra:

- tab A (mike) và tab B (bob) chung SharedWorker, thiết bị C (bob, browser context riêng): cuộn hai
  màn, realtime qua server, ✓ → ✓✓, offline chờ gửi và tab kia thấy ngay, tự gửi khi online,
  `/fail` → ⚠ → Xoá, số chưa đọc, tham gia bằng tên mới;
- thiết bị D (alice) mất mạng thật — trình duyệt đi qua một proxy tắt được, nên trang, SharedWorker
  và service worker cùng mất mạng: tải lại trang khi offline vẫn mở app, đủ hội thoại, mở được hội
  thoại chưa từng mở; tin gửi offline chờ gửi, còn nguyên sau khi tải lại, tự gửi khi có mạng và
  mike nhận được.
