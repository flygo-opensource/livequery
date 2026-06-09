# TODO

## Bugs

- [x] **Custom action (`~verb`) bị mất trong parser** — FIXED: thêm `#action()` extract verb sau `~`, gán vào field `action` của `LivequeryRequest` (type cũng đã thêm). Test: `parseLivequeryRequest.test.ts` ("extracts the custom action verb").
- [ ] **Service metadata không có TTL**: Service crash im lặng vẫn còn trong routing tree mãi mãi — chỉ bị deregister khi forwarded request fail (502). Cần thêm heartbeat timeout hoặc TTL-based expiration
- [x] **Error response thiếu `message` field** — FIXED: cả 3 lỗi gateway (404/503/502) đã thêm `message` mô tả. Test: `api-gateway.test.ts` (verify `error.message` là string non-empty).
- [ ] **WebsocketGateway unsubscribe race condition**: Xóa ref map trước khi remote nodes acknowledge → client reconnect ngay lập tức có thể subscribe 2 lần
- [x] **`LivequeryInterceptor` crash khi không có `LivequeryWebsocketSync` provider** (repo `@livequery/nestjs`, FIXED ở 2.0.58): Phiên bản ≤2.0.57 truy cập `this.LivequeryWebsocketSync.id` ở `LivequeryInterceptor.js:35` không có `?.` (trong khi line 29 và 37 đã có). Khi project bootstrap mới không đăng ký `LivequeryWebsocketSync` (ví dụ thay bằng custom gateway extend `Subject`), `@Optional() @Inject` trả `undefined` → mọi request `/livequery/*` crash `TypeError: undefined is not an object (evaluating 'this.LivequeryWebsocketSync.id')`. **Đã được fix triệt để ở 2.0.58** bằng cách rewrite interceptor sang inject `WebsocketGateway` từ `@livequery/core` thay vì class legacy. Project nào còn pin `@livequery/nestjs` ≤2.0.57 phải patch tạm (`sed` thêm `?.`) hoặc bump lên 2.0.58+.

## Missing features

- [ ] Không có async middleware pipeline — `handle(ctx)` là synchronous, khó compose auth/logging/rate-limiting mà không có side effects
- [ ] Không có rate limiting cho UDP discovery và WebSocket subscriptions — unbounded, dễ bị DoS
- [ ] `ApiGatewayHandler` chỉ có round-robin — không có weighted, least-connections, sticky sessions

## Tests

- [ ] Custom action (`~verb`) parsing: test extract đúng action từ URL
- [ ] Service metadata expiration: test stale service bị cleanup sau timeout
- [ ] Error response format: verify `message` field có trong response body
- [ ] WebSocket subscribe/unsubscribe rapid cycling: test không bị duplicate subscription
- [ ] API forwarding timeout: test behavior khi service không respond
- [ ] `hidePrivateFields` với nested objects: test shallow copy không leak mutated state
