# TODO

## Bugs

- [ ] **Service metadata không có TTL**: Service crash im lặng vẫn còn trong routing tree mãi mãi — chỉ bị deregister khi forwarded request fail (502). Cần thêm heartbeat timeout hoặc TTL-based expiration
- [ ] **WebsocketGateway unsubscribe race condition**: Xóa ref map trước khi remote nodes acknowledge → client reconnect ngay lập tức có thể subscribe 2 lần

## Missing features

- [ ] Không có async middleware pipeline — `handle(ctx)` là synchronous, khó compose auth/logging/rate-limiting mà không có side effects
- [ ] Không có rate limiting cho UDP discovery và WebSocket subscriptions — unbounded, dễ bị DoS
- [ ] `ApiGatewayHandler` chỉ có round-robin — không có weighted, least-connections, sticky sessions

## Tests

- [ ] Service metadata expiration: test stale service bị cleanup sau timeout
- [ ] WebSocket subscribe/unsubscribe rapid cycling: test không bị duplicate subscription
- [ ] `hidePrivateFields` với nested objects: test shallow copy không leak mutated state
