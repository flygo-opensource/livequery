# Todo offline-first

Demo đầy đủ tính năng offline-first của `@livequery/client`, đang chạy tại
**https://livequery-demo.global.flygo.vn**.

```text
tab 1 ─┐                                SharedWorker (một cho mọi tab)
tab 2 ─┼── createRemoteLivequeryClient ──▶ LivequeryClient · local-first (scope 'full')
tab n ─┘   (@livequery/rpc)                IndexedDB · outbox · 1 WebSocket
                                                   │
service worker: app shell (PWA)                    ▼
                          server.ts (Bun): Hono + mongodb({ sync: true })
                          realtime từ change stream của MongoDB
```

- **PWA, chạy khi mất mạng thật**: cài được như app; service worker giữ app shell, nên tải lại
  trang khi không có mạng vẫn mở được, danh sách và hàng đợi còn nguyên (IndexedDB).
- **Giao diện chỉ dùng hai hook**: `useCollection('todos', { mode: { scope: 'full', keep: 'always' } })`
  và `useDocument('livequery/status')` (online, số thay đổi chờ, nút giả lập mất mạng). Không có
  service riêng, không `useObservable`.
- **Các tab đồng bộ tức thì, kể cả khi offline**: client của thư viện chạy trong một SharedWorker
  (`extendedLifetime`, nên tải lại tab cuối không làm rớt kết nối). Chrome trên Android không có
  SharedWorker: khi đó mỗi tab tự chạy client, các tab gặp nhau qua realtime của server.
- **Đồng bộ theo delta**: route `sync: true` — mỗi lần ghi có phiên bản theo thứ tự commit, xoá là
  tombstone; máy vắng mặt lâu chỉ hỏi "đã đổi gì". Todo cũ được gán phiên bản lúc server khởi động
  (`withVersion`), tombstone quá 30 ngày được dọn.
- **Id do client sinh** (uuidv7): server giữ nguyên, gửi lại không tạo bản trùng.
- **Xung đột**: sửa khác field thì gộp; cùng field thì server phát hiện (409 `VERSION_CONFLICT`),
  `conflictResolver` quyết định — mặc định giữ bản của máy gửi sau.

| File | Vai trò |
| --- | --- |
| [server.ts](server.ts) | API + WebSocket + phục vụ bản build của web, một process Bun |
| [web/src/createClient.ts](web/src/createClient.ts) | LivequeryClient: IndexedDB + REST/WebSocket |
| [web/src/worker.ts](web/src/worker.ts) | SharedWorker: expose client qua `WorkerManager` |
| [web/src/livequery.ts](web/src/livequery.ts) | Tab nối vào worker (hoặc tự chạy client khi không có SharedWorker) |
| [web/src/App.tsx](web/src/App.tsx) | Giao diện React — chỉ `useCollection` / `useDocument` |
| [web/sw.js](web/sw.js), [vite.config.ts](vite.config.ts) | Service worker (precache toàn bộ bản build, sinh lúc `vite build`) |
| [smoke.ts](smoke.ts) | Hai client livequery: thêm ở A, B nhận qua realtime |
| [browser-check.ts](browser-check.ts) | Chrome headless: hai tab online/offline, xả hàng đợi, reload; thiết bị D mất mạng thật (proxy tắt được) — mở app offline, thêm todo, reload, có mạng lại tự gửi |

## Chạy local

```bash
# server (cần MongoDB replica set)
MONGO_URL='mongodb://127.0.0.1:27017/?directConnection=true' bun examples/todo-offline/server.ts
# web, dev server có proxy tới :8090
bun run --cwd examples/todo-offline dev:web
```

## Build và deploy

```bash
cd examples/todo-offline
bunx vite build                                          # → dist/
bun build server.ts --target=bun --outdir=dist-server    # → dist-server/server.js
```

Trên homelab `192.168.2.4` bản đang chạy nằm ở `~/apps/livequery-demo`: `dist/`, `dist-server/`
và `.env` (quyền 600: `MONGO_URL` của user MongoDB `livequery_demo`, chỉ có quyền `readWrite` +
`dbAdmin` trên database `livequery_demo`). Container:

```bash
docker run -d --name livequery-demo --restart unless-stopped --network host --env-file .env \
  -e NODE_ENV=production \
  -v "$HOME/apps/livequery-demo/dist:/app/dist:ro" \
  -v "$HOME/apps/livequery-demo/dist-server:/app/dist-server:ro" \
  -w /app oven/bun:1.3 bun dist-server/server.js
```

Publish qua NetBird reverse proxy (`livequery-demo`, target peer `main`, cổng 8090), công khai
không đăng nhập. Server giới hạn 500 todo và tiêu đề 200 ký tự.

Kiểm tra sau khi deploy:

```bash
bun examples/todo-offline/smoke.ts https://livequery-demo.global.flygo.vn
bun examples/todo-offline/browser-check.ts https://livequery-demo.global.flygo.vn
```
