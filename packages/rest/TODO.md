# TODO

## Bugs

- [ ] `add()`: response parsing không deterministic — duyệt tất cả keys tìm `.id`, nếu nhiều keys trùng thì lấy key đầu tiên theo object iteration order. Cần validate response structure rõ ràng hơn
- [x] `add()`/`update()` lọc field `_` không đồng nhất — FIXED: tách helper `#stripPrivateFields`, dùng chung cho `add` và `update` (`delete` không có body). Test: "update strips client-private (underscore) fields before sending".
- [ ] `LivequeryCollectionResponse<T>` type khai báo cả `items: T[]` và `item: T` là required trong khi 2 cái này mutually exclusive — nên dùng discriminated union

## Missing features

- [ ] Không có request timeout — `fetch()` có thể hang vô thời hạn, cần thêm config timeout với AbortController
- [ ] Không có AbortController integration — query cũ không bị cancel khi query mới bắt đầu, có thể gây duplicate results trên mạng chậm
- [~] Không có retry logic cho HTTP errors — WON'T FIX (by design): mất mạng thì báo lỗi ngay cho caller xử lý, không retry ngầm (tránh che giấu lỗi và nhân đôi side-effect của write). Socket auto-reconnect là chuyện khác (giữ kênh realtime sống).
- [~] WebSocket unavailable (SSR, Node) silent degrade — WON'T FIX (by design): đây chính là hành vi mong muốn cho SSR — không có `WebSocket` thì bỏ qua realtime, không cần cảnh báo. Query HTTP vẫn chạy bình thường.

## Tests

- [ ] `onRequest` hook: test fake response (skip network), test header merging
- [ ] `onResponse` hook: test được gọi đúng lúc
- [ ] `add()` / `update()` / `delete()`: test non-2xx errors, parse errors
- [ ] `trigger()`: test URL construction và response handling
- [ ] WebSocket subscription/unsubscription: test listen_count và cleanup
- [ ] Realtime merge với HTTP: test timing, test không bị duplicate
- [ ] Socket reconnection: test session counter increment
- [ ] Socket gateway ID propagation vào REST headers
- [ ] Paging metadata: test count, cursor fields
