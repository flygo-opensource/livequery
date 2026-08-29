# TODO

## Bugs (high priority)

- [ ] **Race condition trong observable caching** (`ServiceLinker`): nhiều concurrent calls đến cùng remote observable trước khi cache setup xong sẽ tạo nhiều subscription độc lập trên worker — cần check `observables.has(key)` trước khi tạo mới hoặc dùng Promise-based lock
- [ ] **Không có readiness mechanism**: client gọi service trước khi worker ready thì messages bị queue silently và fail — cần thêm `waitReady()` hoặc readiness event
- [~] **Không có timeout**: WON'T FIX (by design). RPC channel này chỉ chạy trong browser (foreground ↔ SharedWorker), không phải network call — worker "treo" gần như không xảy ra trong thực tế, và nếu worker chết thì port `disconnect` đã dọn dẹp (xem mục responses leak). Không thêm timeout để tránh phức tạp hóa.

## Bugs (medium priority)

- [x] Worker error chỉ serialize `.message` — FIXED: `RpcMessage.response` thêm field `stack`; `WorkerManager` gửi `err?.stack`, `ServiceLinker` gán lại vào `Error.stack` phía client. Test: `regression.test.ts` ("worker errors propagate the worker-side stack").
- [x] `WorkerManager` path resolution không guard prototype chain — FIXED: thêm `FORBIDDEN_PROPS` (`constructor`/`prototype`/`__proto__`) chặn ở mỗi cấp `#call`. Test: "WorkerManager blocks prototype-chain access".
- [x] `responses` map không auto-cleanup khi client offline — FIXED: channel phát message `disconnect` kèm `connection_id` khi port đóng; `WorkerManager` hủy mọi subscription thuộc connection đó. Test: "disconnect releases streaming subscriptions for that connection".
- [ ] `RpcMessage.id` dùng simple counter thay vì UUID — có thể collision nếu nhiều workers. `uuidv7` đã có trong deps nhưng chưa dùng

## Tests

- [ ] Observable streaming: test subscription flow end-to-end
- [ ] Cancellation: test unsubscribe → cancel message được gửi → worker cleanup
- [ ] Error propagation: test worker error → client nhận được Error object
- [ ] Concurrent requests: test ID isolation giữa các requests
- [ ] Nested method paths: test deep path resolution
- [ ] Remote BehaviorSubject caching: test observable được reuse thay vì tạo mới
- [ ] `LimitConcurrency`: test giới hạn concurrency thực sự hoạt động (không chỉ `this` binding)
- [ ] `RxjsQueue`: test queue stress với concurrency > 1
- [ ] `StorageBehaviorSubject`: test async storage initialization
- [ ] `SharedWorkerChannel`: integration test foreground ↔ worker messaging
