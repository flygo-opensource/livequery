# Thiết kế Livequery

Tài liệu này mô tả kiến trúc hiện tại: một API vừa trả REST vừa đẩy realtime, chạy được trên
Node.js, Bun và Cloudflare Workers với cùng một cách viết.

## 1. Mục tiêu

1. **Một giao thức cho cả đọc lẫn realtime.** Client gọi `GET /livequery/tasks` như REST thường,
   và nhận thay đổi của đúng tập dữ liệu đó qua WebSocket, không phải tự khai báo subscription.
2. **Service không phụ thuộc hạ tầng.** Cùng một file service chạy trên Node, Bun hay Worker;
   chỉ datasource là khác.
3. **Mọi giới hạn đều lộ ra ở chỗ khai báo.** Cột nào được lọc, ai được đọc, publish đi đâu — tất
   cả nằm trên dòng khai báo route, không nằm rải trong thân hàm.
4. **Không có bước ẩn.** Không sinh mã, không quét thư mục, không decorator ma thuật. Một request
   đi qua một chuỗi middleware đọc được từ trên xuống.

## 2. Hình dạng một request

```text
validator(Schema) ─▶ livequery() ─▶ datasource ─▶ realtime()
   kiểm tra body        phân tích       chạy truy vấn     subscribe sau khi đọc
   công bố allowlist    thành ref,      dựng response     publish sau khi ghi
                        keys, query     rồi next()
```

Điểm quan trọng nhất của thứ tự này: **datasource dựng response trước rồi mới gọi `next()`**.
Hono bỏ qua giá trị trả về của handler một khi response đã tồn tại, và trả 404 khi chuỗi kết thúc
bằng một `next()` không ai xử lý. Dựng trước tránh cả hai, và nhờ đó `realtime()` đứng cuối vẫn
gắn được header lên response.

Schema đóng hai vai: kiểm tra dữ liệu ghi, và **là danh sách cột được phép** lọc, sắp xếp, ghi.
Không có hai nguồn sự thật cho cùng một câu hỏi "client được chạm vào cột nào".

## 3. Realtime

Client mở đúng một WebSocket tới gateway. Việc đăng ký xảy ra **phía server, sau một lần đọc đã
được phân quyền** — client không tự gửi frame `subscribe` được (mặc định gateway bỏ qua), nên
không thể nghe một ref mà nó chưa từng đọc nổi.

```text
client ─ GET /livequery/tasks ─▶ gateway ─▶ service
                                          ◀─ 200 + x-livequery-ref: tasks
        gateway: subscribe(client, ref) rồi xóa header

client ─ POST /livequery/tasks ─▶ gateway ─▶ service
                                           ◀─ 201 {item} + x-livequery-change: added tasks
        gateway: publish(change) ──▶ mọi client đang nghe ref đó
```

Service chỉ **báo việc cần làm qua response header**; nó không giữ socket và không biết socket nằm
ở đâu. Nhờ vậy cùng một service chạy sau một gateway trong process (Node, Bun) hay sau một gateway
Worker với Durable Object.

Khi service có change feed thật (change stream của Mongo, `LISTEN/NOTIFY` của Postgres), nó bỏ qua
cơ chế header và đẩy thẳng vào realtime gateway trong process. Khi không có (D1), realtime đến từ
đường ghi — và **chỉ đường ghi qua API mới sinh realtime**.

## 4. Gateway

Gateway định tuyến **theo tiền tố path**, khai báo trong một file routing:

```json
{
  "services": { "tasks": { "binding": "TASKS_SERVICE", "url": "http://tasks:8081" } },
  "routes": { "livequery": { "tasks": { "$service": "tasks" },
                             "customers": { ":customer_id": { "orders": { "$service": "orders" } } } } }
}
```

- Key có tiền tố `$` là metadata, còn lại là một đoạn path; `:name` khớp mọi đoạn.
- `$service` và `$auth` kế thừa xuống dưới, và `$service` **sâu nhất thắng**.
- Một service sở hữu mọi route dưới tiền tố của nó, nên **thêm route con chỉ cần deploy service**.
  Chỉ khi thêm service mới thì gateway mới phải deploy lại, vì cần thêm binding.
- `target` mang cả `binding` (Cloudflare Service Binding) lẫn `url`; runtime nào dùng thứ nó có.

Đổi lại, gateway không biết route cụ thể, nên 404 và 405 do service trả, và việc suy ra `ref` cho
realtime cũng do service làm (qua header ở mục 3).

## 5. Ranh giới runtime

Một package, chia theo entry point. Runtime tự chọn phần của mình, code ứng dụng không kiểm tra
runtime:

```text
@livequery/core            Contract, parser, realtime protocol, prefix routing.
                           Không chạm Node built-in hay ws → an toàn trên Worker.
@livequery/core/node       + WebsocketGateway (ws), helper http ↔ Fetch.
@livequery/core/bun        + BunWebsocketGateway.
@livequery/core/workers    + HibernatableWebsocketGateway, router, publisher.
```

`@livequery/honojs` làm tương tự cho `serve()` và `realtimeGateway()`, qua export condition
`workerd` / `bun` / `node`. `core/tests/root-entrypoint.test.ts` duyệt đồ thị import của root và
`/workers` rồi fail nếu có ai kéo module Node vào — ranh giới này là test, không phải quy ước.

| | Node | Bun | Cloudflare Workers |
| --- | --- | --- | --- |
| HTTP server | `http.createServer` | `Bun.serve` | handler `fetch` |
| Socket của client | `WebsocketGateway` (ws) | `BunWebsocketGateway` | Durable Object |
| Datasource | MongoDB, Postgres | MongoDB, Postgres | D1 |
| Gateway gọi service | `fetch(url)` | `fetch(url)` | Service Binding |
| Việc chạy nền | timer trong process | timer trong process | alarm, Cron Trigger, Queue |

## 6. Realtime trên Cloudflare

Socket nằm trong Durable Object, chia shard theo principal:

- **Gateway id là id của Durable Object.** `hello.gid` và `x-lgid` vì thế không đổi khi object bị
  evict hay khi deploy lại.
- **Trạng thái nằm ngoài bộ nhớ.** Danh tính socket lưu trong attachment, subscription lưu trong
  storage; instance mới khôi phục cả hai trong `blockConcurrencyWhile` trước khi nhận event.
- **Chờ reconnect bằng alarm, không bằng timer.** Object ngủ được trong lúc chờ, và cửa sổ chờ
  sống sót qua eviction. Cùng alarm đó quét dọn bản ghi không còn socket.
- **Ping do runtime trả lời** (`setWebSocketAutoResponse`), nên client rảnh không đánh thức object.

Mô hình tin cậy: chỉ Worker chạm được Durable Object; router luôn ghi đè header principal nên
client không tự chọn danh tính; `register` từ chối khi socket thuộc principal khác; và một
principal khác không `start` được bằng `client_id` đang có subscription của người khác.

Giới hạn cần nhớ khi mở rộng: mỗi Durable Object có trần mềm 1.000 request/giây, nên chia shard là
bắt buộc. Publish hiện fan-out tới mọi shard, chi phí ghi tăng tuyến tính theo số shard; hệ thống
lớn nên chuyển sang shard theo tenant hoặc thêm một sổ đăng ký ref → shard.

## 7. An toàn dữ liệu

| Rủi ro | Cách chặn |
| --- | --- |
| SQL injection qua tên cột | Mọi identifier phải khớp `^[A-Za-z_][A-Za-z0-9_]{0,63}$` trước khi vào SQL; D1 chỉ bind được giá trị, không bind được identifier |
| Client chạm cột không được phép | Schema của `validator()` là allowlist; cột ngoài danh sách bị từ chối 400 |
| Client nghe ref chưa được phép đọc | Frame `subscribe` từ client bị bỏ qua; subscription chỉ tạo sau một lần đọc đã phân quyền |
| Client hủy subscription của người khác | `unsubscribe` chỉ gỡ ref của chính socket đó |
| Lộ chi tiết nội bộ qua lỗi | `errorHandler()` giữ nguyên 4xx, còn 5xx chỉ ghi log và trả thông báo chung |
| Vượt trần tham số của D1 | Danh sách `in`/`nin` bị chặn ở 50 giá trị |

## 8. Những gì đã bỏ, và vì sao

- **Discovery lúc chạy** (UDP multicast, HTTP registry) và **gateway proxy theo IP:port**. Chúng
  không chạy được trên Worker, nên hệ thống phải có hai cách viết service. Định tuyến theo tiền tố
  khai báo sẵn chạy ở mọi nơi, và trên Cloudflare thì binding vốn đã tĩnh nên discovery không thêm
  được gì.
- **Tách thành nhiều package nhỏ** (`protocol`, `service`, `gateway`, `realtime-*`,
  `gateway-controller-*`). Mỗi bản sửa phải làm hai lần vì `core` giữ bản sao của cùng đoạn code.
  Ranh giới runtime giờ do entry point giữ, và có test canh.
- **Decorator kiểu NestJS.** Cần `experimentalDecorators` và `reflect-metadata`, xung đột với dự án
  dùng decorator chuẩn, và giấu mất thứ tự thực thi. Middleware của Hono cho cùng khả năng mà đọc
  được từ trên xuống.

## 9. Điểm còn mở

- Trên Worker, ghi thẳng vào D1 (script, migration, dashboard) không sinh realtime. Muốn có thì
  phải tự gọi publish.
- Publish fan-out tới mọi shard; xem mục 6 cho hướng mở rộng.
