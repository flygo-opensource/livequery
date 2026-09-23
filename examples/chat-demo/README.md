# Chat demo

Demo chat local-first dựng trên livequery, đang chạy tại **https://livequery-chat.global.flygo.vn**.

```text
tab 1 (mike) ─┐                      SharedWorker (một cho mọi tab, mọi tài khoản)
tab 2 (bob)  ─┼── @livequery/rpc ──▶ ChatService
tab n        ─┘                        LivequeryClient · IndexedDB · outbox · 1 WebSocket
                                                │
                                                ▼
                         server.ts (Bun): Hono + MongoDatasource + change stream
```

## Trang

| Đường dẫn | Nội dung |
| --- | --- |
| `/accounts` | Tài khoản trên server (seed: mike, bob, alice). Bấm để đăng nhập; nhập tên để tham gia (tạo tài khoản trên server, trùng tên thì vào tài khoản đó). Nhiều tài khoản đăng nhập cùng lúc trên một trình duyệt |
| `/accounts/:account_id` | Hội thoại của tài khoản, mới nhất trên đầu, cuộn vô cực (20/trang), số tin chưa đọc, tạo chat 1-1 hoặc nhóm |
| `/accounts/:account_id/chats/:chat_id` | Tin nhắn, mới nhất dưới cùng, cuộn lên để tải tin cũ (30/trang), trạng thái gửi |

## Trạng thái tin nhắn

| | Khi nào | Nguồn |
| --- | --- | --- |
| ⏳ Đang gửi | Đang trên đường lên server | `_adding` |
| 🕓 Chờ gửi | Offline, nằm trong outbox; tự gửi khi có mạng | `_queued` |
| ✓ Đã gửi | Server đã nhận | không còn cờ |
| ✓✓ Đã xem / ✓✓ 1/2 | Mọi (hoặc một số) thành viên khác đã mở hội thoại | `read_at` của chat trên server |
| ⚠ Gửi lỗi | Server từ chối — gõ tin bắt đầu bằng `/fail` để thử; có nút **Gửi lại** / **Xoá** | `_adding_error`, `collection.retry()` |

Nút gạt Online/Offline chặn mọi request HTTP của SharedWorker, nên áp dụng cho mọi tab.

## Dữ liệu (MongoDB `livequery_chat_demo`)

- `accounts { _id: UUID, name, name_key (unique), color, created_at }`
- `chats { _id: UUID, type: direct|group, title?, member_ids[], member_key? (chat 1-1 không trùng), last_message, read_at{account: ts}, unread{account: n}, updated_at }`
- `messages { _id: UUID (id do client sinh), chat_id, sender_id, text, created_at }`

Realtime từ change stream: `accounts`, `accounts/:member_ids/chats` (chia theo mảng thành viên),
`chats` và `chats/:chat_id/messages`. Gửi tin xong server cập nhật `last_message`, `updated_at` và
`unread` của chat, nên danh sách hội thoại của mọi thành viên nhảy lên đầu. Mở hội thoại gọi
action `POST /livequery/chats/:id/~read`.

Demo không có mật khẩu: ai biết tên đều vào được tài khoản đó. Server giới hạn 500 tài khoản,
2000 hội thoại, 50 000 tin.

## Chạy, build, deploy

```bash
MONGO_URL='mongodb://127.0.0.1:27017/?directConnection=true' bun examples/chat-demo/server.ts
bun run --cwd examples/chat-demo dev:web            # dev server, proxy tới :8091

cd examples/chat-demo
bunx vite build && bun build server.ts --target=bun --outdir=dist-server
```

Trên `192.168.2.4`: `~/apps/livequery-chat` (`dist/`, `dist-server/`, `.env` quyền 600 với user
MongoDB `livequery_chat` chỉ có quyền trên `livequery_chat_demo`), container `livequery-chat`
(`oven/bun:1.3`, `--network host`, cổng 8091), publish qua NetBird (`livequery-chat`).

## Kiểm tra

```bash
bun examples/chat-demo/browser-check.ts https://livequery-chat.global.flygo.vn
```

Chrome headless: tab A (mike) và tab B (bob) chung SharedWorker, thiết bị C (bob, browser context
riêng). 28 kiểm tra: cuộn vô cực hai màn, realtime qua server, ✓ → ✓✓, offline chờ gửi và tab kia
thấy ngay, tự gửi khi online, `/fail` → ⚠ → Xoá, số chưa đọc, tham gia bằng tên mới.
