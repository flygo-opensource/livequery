# Ứng dụng todo với Hono và MongoDB

Một process duy nhất: API, WebSocket của client và một trang web nhỏ. **Cùng một file chạy trên
Node lẫn Bun**:

```bash
node todo-mongodb/index.ts     # hoặc: bun todo-mongodb/index.ts
```

Chạy từ thư mục `examples`, rồi mở http://localhost:8082. Node cần bản 22.18 trở lên để chạy
thẳng file `.ts`.

## Realtime đến từ change stream, không từ đường ghi

Khác với D1, MongoDB có change stream — nên service không cần tự publish sau mỗi lần ghi:

```text
browser ── GET /livequery/todos ──▶ realtime() đăng ký client vào ref "todos"
        ── POST / PATCH / DELETE ─▶ mongodb() ghi, trả 201/200, hết
                                     │
mongosh, cron, service khác ─────────┤
                                     ▼
                            change stream của collection
                                     │  MongodbRealtime.watch()
                                     ▼
                              gateway.next(change) ──▶ mọi client đang nghe "todos"
```

Vì vậy `realtime()` chỉ nằm trên các route GET. Một `db.todos.insertOne(...)` gõ trong mongosh
hiện lên trong trình duyệt y hệt như khi bấm nút Add — và không có sự kiện nào bị nhân đôi.

| File | Vai trò |
| --- | --- |
| [index.ts](index.ts) | Schema, chuỗi middleware, change stream, `serve()` |
| [config.ts](config.ts) | Port và địa chỉ MongoDB |
| [public/index.html](public/index.html) | Client viết bằng JS thuần: một WebSocket rồi `fetch` như REST bình thường |
| [e2e.test.ts](e2e.test.ts) | Chạy file `index.ts` trên cả Node và Bun với MongoDB thật |

Chuỗi middleware giống hệt các example khác, chỉ khác datasource:

```ts
app.get('/livequery/todos', check, livequery(), mongodb({ connection: db }), realtime(gateway))
app.post('/livequery/todos', check, livequery(), mongodb({ connection: db }))
```

`validator(Todo)` vừa kiểm tra body vừa là **danh sách field được phép** lọc và sắp xếp, nên
`?is_admin=1` bị trả 400 `FIELD_NOT_ALLOWED` thay vì đi thẳng vào MongoDB.

## Yêu cầu

MongoDB phải là **replica set** — change stream không tồn tại trên mongod đơn lẻ. Một node là đủ:

```bash
docker run -d -p 27017:27017 --name livequery-mongo mongo:7 --replSet rs0 --bind_ip_all
docker exec livequery-mongo mongosh --quiet --eval 'rs.initiate()'
```

Collection được tạo lúc khởi động, kèm `changeStreamPreAndPostImages` để sự kiện `removed` còn
mang theo document vừa bị xóa (cần quyền `collMod`).

## Biến môi trường

| Tên | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `8082` | Port của HTTP API, trang web và WebSocket |
| `MONGO_URL` | `mongodb://127.0.0.1:27017/?replicaSet=rs0` | Chuỗi kết nối |
| `DB_NAME` | `livequery_examples` | Tên database |
| `COLLECTION` | `todos` | Tên collection |

## Test

```bash
bun test todo-mongodb/e2e.test.ts
```

Chạy `index.ts` trên cả Node và Bun với một collection riêng cho mỗi lần chạy, và kiểm tra: CRUD,
giá trị mặc định của schema, realtime `added`/`modified`/`removed`, **một insert ngoài API cũng
tới được client**, từ chối body sai và field lạ, lọc theo `done:eq-boolean`, 404 cho path lạ,
CORS preflight, và trang web trả về được.

Trỏ sang server khác bằng `LIVEQUERY_E2E_MONGO_URL`. Runtime nào không mở nổi kết nối TCP tới
MongoDB thì nhánh đó bị skip kèm lý do — trên macOS, `node` chưa được cấp quyền *Local Network*
sẽ nhận `EHOSTUNREACH` với mọi địa chỉ LAN.

## Giới hạn

- Chưa có xác thực: mọi client đọc và ghi được toàn bộ collection. Thêm middleware trước
  `livequery()` và lọc theo `req.keys` nếu cần.
- Một process giữ cả socket lẫn change stream. Chạy nhiều bản sao thì mỗi bản mở change stream
  riêng, và client chỉ nhận được thay đổi qua process mà nó đang nối — muốn chia tải thì tách
  gateway ra như [`examples/api-gateway`](../api-gateway/README.md).
