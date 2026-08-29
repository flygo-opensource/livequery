# @livequery/protocol

Contract và parser trung lập runtime của Livequery. Package này không mở HTTP
server, không kết nối database, không thực hiện service discovery và không phụ
thuộc Node, Bun hoặc Cloudflare.

## Cài đặt

```sh
bun add @livequery/protocol
```

## API chính

- `LivequeryContext`, `LivequeryHandler`, `LivequeryRequest`, `RawRequest`.
- `LivequeryDatasource` và datasource initialization types.
- `LivequeryRequestParser` chuẩn hóa HTTP request thành Livequery ref.
- `LivequeryBaseEntity`, `UpdatedData` và realtime wire-event types.
- Query/filter types và `hidePrivateFields`.

## Ví dụ parser

```ts
import { LivequeryRequestParser, type LivequeryContext } from '@livequery/protocol'

const context: LivequeryContext = {
  request: {
    path: '/livequery/orders/order-42',
    ref: '/livequery/orders/:id',
    method: 'GET',
    params: { id: 'order-42' },
    query: {},
    headers: new Map(),
  },
}

await new LivequeryRequestParser().handle(context)
console.log(context.livequery?.ref)
```

## Quy tắc phụ thuộc

Mọi framework adapter và database adapter có thể phụ thuộc package này. Package
này không được phụ thuộc ngược vào gateway, service publisher hoặc runtime
WebSocket implementation.
