# API reference

## Base URL

Local:

```text
http://localhost:8787
```

Production dùng URL `workers.dev`, custom domain hoặc route của `livequery-api-gateway`. Hai service API không có public URL trong cấu hình example.

Mọi request dưới `/livequery/` phải gửi token (danh sách token là secret `API_TOKENS` của Gateway):

```http
Authorization: Bearer <token>
```

Tất cả write request phải gửi:

```http
Content-Type: application/json
```

## Realtime

WebSocket: `GET /livequery/realtime-updates?token=<token>` (trình duyệt không đặt được header cho
WebSocket nên token đi qua query).

1. Gửi `{"event":"start","data":{"id":"<client_id>"}}`, nhận `{"event":"hello","gid":"<gateway_id>"}`.
2. Gửi các GET kèm `x-lcid: <client_id>` và `x-lgid: <gateway_id>`. Gateway đăng ký client cho ref đó.
3. Mỗi thay đổi đến dưới dạng `{"event":"sync","cids":[...],"data":{"changes":[{"ref","type","data","id"}]}}`
   với `type` là `added`, `modified` hoặc `removed`.
4. Gửi `{"event":"unsubscribe","data":{"ref":"tasks"}}` để ngừng nhận ref đó.

## Routes

| Method | Path | Binding | Ý nghĩa |
| --- | --- | --- | --- |
| `GET` | `/health` | Gateway | Health check của Gateway |
| `GET` | `/livequery/tasks` | `TASKS_SERVICE` | Danh sách task |
| `POST` | `/livequery/tasks` | `TASKS_SERVICE` | Tạo task |
| `GET` | `/livequery/tasks/:id` | `TASKS_SERVICE` | Chi tiết task |
| `PUT` | `/livequery/tasks/:id` | `TASKS_SERVICE` | Cập nhật task |
| `PATCH` | `/livequery/tasks/:id` | `TASKS_SERVICE` | Cập nhật một phần task |
| `DELETE` | `/livequery/tasks/:id` | `TASKS_SERVICE` | Xóa task |
| `GET` | `/livequery/incidents` | `INCIDENTS_SERVICE` | Danh sách sự cố |
| `POST` | `/livequery/incidents` | `INCIDENTS_SERVICE` | Tạo sự cố |
| `GET` | `/livequery/incidents/:id` | `INCIDENTS_SERVICE` | Chi tiết sự cố |
| `PUT` | `/livequery/incidents/:id` | `INCIDENTS_SERVICE` | Cập nhật sự cố |
| `PATCH` | `/livequery/incidents/:id` | `INCIDENTS_SERVICE` | Cập nhật một phần sự cố |
| `DELETE` | `/livequery/incidents/:id` | `INCIDENTS_SERVICE` | Xóa sự cố |

Trong implementation hiện tại, `PUT` và `PATCH` đều cập nhật các field có trong body; `PUT` chưa bắt buộc gửi toàn bộ document.

## Tasks

### Schema

| Field | Type | Required khi tạo | Default | Có thể ghi |
| --- | --- | --- | --- | --- |
| `id` | string UUID | Server tạo | - | Không |
| `title` | string | Có | - | Có |
| `status` | string | Không | `todo` | Có |
| `assignee_id` | string hoặc null | Không | `null` | Có |
| `created_at` | Unix timestamp | Server tạo | `unixepoch()` | Không |

### Tạo task

```bash
curl -X POST http://localhost:8787/livequery/tasks \
  -H 'content-type: application/json' \
  -d '{
    "title": "Kiểm tra định kỳ thang A01",
    "status": "todo",
    "assignee_id": "technician-01"
  }'
```

Response `201 Created`:

```json
{
  "item": {
    "id": "generated-uuid",
    "title": "Kiểm tra định kỳ thang A01",
    "status": "todo",
    "assignee_id": "technician-01"
  }
}
```

### Cập nhật task

```bash
curl -X PATCH http://localhost:8787/livequery/tasks/task-01 \
  -H 'content-type: application/json' \
  -d '{"status":"done"}'
```

### Xóa task

```bash
curl -X DELETE http://localhost:8787/livequery/tasks/task-01
```

## Incidents

### Schema

| Field | Type | Required khi tạo | Default | Có thể ghi |
| --- | --- | --- | --- | --- |
| `id` | string UUID | Server tạo | - | Không |
| `elevator_id` | string | Có | - | Có |
| `title` | string | Có | - | Có |
| `severity` | string | Không | `warning` | Có |
| `status` | string | Không | `open` | Có |
| `created_at` | Unix timestamp | Server tạo | `unixepoch()` | Không |

### Tạo sự cố

```bash
curl -X POST http://localhost:8787/livequery/incidents \
  -H 'content-type: application/json' \
  -d '{
    "elevator_id": "A01",
    "title": "Cửa tầng 3 bị kẹt",
    "severity": "high"
  }'
```

### Lọc sự cố theo thang máy

```bash
curl 'http://localhost:8787/livequery/incidents?elevator_id=A01&status=open'
```

## Query syntax

### Pagination

| Query | Ý nghĩa |
| --- | --- |
| `:limit` | Số item mỗi trang; mặc định `10`, tối đa `100` |
| `:page` | Phân trang theo số trang, bắt đầu từ `1` |
| `:after` | Lấy trang tiếp theo từ cursor |
| `:before` | Lấy trang trước từ cursor |

Ví dụ page-based:

```bash
curl 'http://localhost:8787/livequery/tasks?:page=2&:limit=20'
```

Ví dụ cursor-based:

```bash
curl 'http://localhost:8787/livequery/tasks?:limit=20&:after=CURSOR'
```

Không nên gửi đồng thời `:page` với `:after` hoặc `:before`; implementation hiện tại ưu tiên `:page`.

### Sorting

Thêm hậu tố `:sort` vào field. Giá trị `asc` hoặc `1` là tăng dần; các giá trị khác được xử lý như giảm dần.

```bash
curl 'http://localhost:8787/livequery/tasks?status=todo&created_at:sort=desc&:limit=20'
```

Datasource luôn thêm `id` làm tiebreaker để cursor ổn định.

### Filtering

Không có hậu tố nghĩa là so sánh bằng:

```text
status=todo
elevator_id=A01
```

Các operator được hỗ trợ:

| Operator | Ví dụ | SQL tương đương |
| --- | --- | --- |
| `eq` | `status:eq=open` | `=` |
| `ne` | `status:ne=closed` | `!=` |
| `gt`, `gte` | `created_at:gte=1700000000` | `>`, `>=` |
| `lt`, `lte` | `created_at:lt=1800000000` | `<`, `<=` |
| `eq-number`, `neq-number` | `created_at:eq-number=1700000000` | numeric equality |
| `eq-boolean`, `neq-boolean` | Chỉ dùng khi schema có field boolean | boolean equality |
| `eq-null`, `neq-null` | `assignee_id:eq-null=1` | `IS NULL`, `IS NOT NULL` |
| `in`, `nin` | `status:in=open,investigating` | `IN`, `NOT IN` |
| `like` | `title:like=cửa` | case-insensitive contains |

Operator chỉ dùng được với field nằm trong allowlist của service. Một operator có trong datasource nhưng field không thuộc schema vẫn bị trả `400`.

## Collection response

```json
{
  "items": [],
  "cursor": {
    "first": null,
    "last": null
  },
  "has": {
    "prev": false,
    "next": false
  },
  "count": {
    "prev": 0,
    "next": 0,
    "current": 0,
    "total": 0
  },
  "page": {
    "current": 1,
    "total": 0
  }
}
```

`count.total` đến từ truy vấn `COUNT(*)`. Vì vậy collection request không chỉ đọc page hiện tại mà còn thực hiện count query; điều này có thể làm tăng D1 rows read. Với bảng lớn, có thể cân nhắc:

- chỉ trả `has.next` bằng cách đọc `limit + 1`;
- cache hoặc duy trì counter riêng;
- chỉ tính total khi client yêu cầu;
- dùng bảng aggregate/read model cho báo cáo.

## Document response

```json
{
  "item": {
    "id": "task-01",
    "title": "Kiểm tra thang A01",
    "status": "todo",
    "assignee_id": null,
    "created_at": 1700000000
  }
}
```

## Error response

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Document not found"
  }
}
```

Các status thường gặp:

| Status | Trường hợp |
| --- | --- |
| `400` | JSON/body/query field không hợp lệ hoặc thiếu field bắt buộc |
| `404` | Route/method chưa đăng ký, hoặc document không tồn tại khi đọc |
| `415` | Write request không dùng `application/json` |
| `500` | Lỗi D1 hoặc cấu hình service |
| `502` | Gateway không gọi được downstream service |
