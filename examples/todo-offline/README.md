# Todo offline-first

Demo đầy đủ tính năng offline-first của `@livequery/client`, đang chạy tại
**https://livequery-demo.global.flygo.vn**.

```text
tab 1 ─┐                     SharedWorker (một cho mọi tab)
tab 2 ─┼── @livequery/rpc ──▶ TodoService
tab n ─┘                       LivequeryClient · local-first
                               IndexedDB · outbox · 1 WebSocket
                                        │
                                        ▼
                     server.ts (Bun): Hono + MongoDatasource
                     realtime từ change stream của MongoDB
```

- **Các tab đồng bộ tức thì, kể cả khi offline**: client chạy trong một SharedWorker, các tab chỉ
  là giao diện nối vào qua `@livequery/rpc`. Chrome trên Android không có SharedWorker: khi đó mỗi
  tab tự chạy `TodoService`, các tab gặp nhau qua realtime của server.
- **Offline**: đọc/ghi vào IndexedDB, ghi nằm trong outbox, tự gửi lại khi có mạng. Nút "Giả lập
  mất mạng" chặn mọi request HTTP của worker (áp dụng cho mọi tab); DevTools → Offline cắt cả socket.
- **Id do client sinh** (uuidv7): server giữ nguyên, gửi lại không tạo bản trùng.
- **Xung đột**: sửa khác field thì gộp, cùng field thì bên ghi sau thắng.

| File | Vai trò |
| --- | --- |
| [server.ts](server.ts) | API + WebSocket + phục vụ bản build của web, một process Bun |
| [web/src/TodoService.ts](web/src/TodoService.ts) | LivequeryClient, collection, trạng thái đồng bộ — chạy trong worker |
| [web/src/worker.ts](web/src/worker.ts) | SharedWorker: expose `TodoService` qua `WorkerManager` |
| [web/src/service.ts](web/src/service.ts) | Tab nối vào worker (hoặc tự chạy service khi không có SharedWorker) |
| [web/src/App.tsx](web/src/App.tsx) | Giao diện React |
| [smoke.ts](smoke.ts) | Hai client livequery: thêm ở A, B nhận qua realtime |
| [browser-check.ts](browser-check.ts) | Chrome headless, hai tab: đồng bộ online/offline, xả hàng đợi, reload |

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
