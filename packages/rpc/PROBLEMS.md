# PROBLEMS — @livequery/rpc

Vấn đề phát hiện trong phiên debug larkpanel (login màn trắng / không redirect).
Root cause thật của bug đó nằm Ở ĐÂY, không phải ở `@livequery/react`.
Người ghi: agent debug larkpanel admin-panel.

---

## 1. Observable-property của service là **Proxy bọc callable** → consumer hiểu nhầm

### Vị trí
`src/ServiceLinker.ts` → hàm `build()` (dòng ~72-108).

```ts
const build = (paths = []) => {
    const fn = (...args) => rpc(paths, args)   // (1) một function
    return new Proxy(fn, {                       // (2) Proxy bọc QUANH function
        get: (_, prop) => {
            if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') { ... }
            return build([...paths, prop])       // (3) property con cũng là proxy-callable
        },
        ...
    })
}
```

### Vấn đề
Vì proxy bọc một **function**, mọi property của service — kể cả observable như
`service.accounts$` — đều có `typeof === 'function'`. Không có cách nào phân biệt:
- "đây là METHOD cần gọi" `service.doSomething(args)`
- với "đây là OBSERVABLE property cần subscribe" `service.accounts$`

### Hệ quả thực tế
Consumer dùng heuristic phổ biến `typeof x === 'function' ? x() : x` (vd
`@livequery/react` `useObservable`) sẽ **GỌI observable như một factory** → nhận
sai giá trị → crash. Ca thật: larkpanel `useObservable(auth.accounts$)` → render
đầu trả undefined → `accounts.current_account_id` ném `TypeError` → màn hình trắng.

Đây là bug ảnh hưởng MỌI consumer, không riêng react. Hiện đã phải vá phòng thủ ở
`@livequery/react` (xem `react/PROBLEMS.md`) — nhưng đó chỉ là workaround.

### Hướng fix (chọn 1)
- **(A) Tách method khỏi observable-property:** observable-property (`xxx$`) trả về
  Observable THUẦN (không phải Proxy-callable) → `typeof === 'object'`, consumer
  nhận diện đúng. Method vẫn trả thenable-observable callable như cũ.
- **(B) Gắn brand/Symbol:** đính `Symbol.for('livequery.observable')` lên proxy-
  observable để consumer kiểm tra bằng brand thay vì `typeof`. Ít breaking hơn (A).

---

## 2. Observable proxy seed bằng `new BehaviorSubject(null)` → không phân biệt loading vs null

### Vị trí
`src/ServiceLinker.ts` dòng ~82: `const sbj = new BehaviorSubject(null)`.

### Vấn đề
Trước khi giá trị thật về từ worker, observable emit `null`. Consumer không phân
biệt được "đang loading" với "giá trị thật = null". Buộc phía react phải fallback
`?? default_value` cho cả giá trị emit (che mất null hợp lệ).

### Hướng fix
Dùng một sentinel "chưa có giá trị" (vd `Symbol`/undefined-marker riêng) thay vì
`null`, hoặc kèm cờ trạng thái loading trong payload, để consumer phân biệt được.

---

## 3. `getValue()` trên proxy không phản ánh giá trị thật ở worker

### Vị trí
`src/ServiceLinker.ts` dòng ~93: `getValue: () => sbj.getValue()`.

### Vấn đề
`getValue()` chỉ trả giá trị của `sbj` nội bộ proxy. Nếu chưa từng subscribe (chưa
mở stream tới worker), `sbj` vẫn là giá trị seed (`null`) — không phải state thật ở
worker. Consumer gọi `getValue()` để đọc đồng bộ sẽ nhận giá trị sai/cũ.

### Hướng fix
Hoặc tài liệu hoá rõ "getValue chỉ hợp lệ sau khi đã subscribe", hoặc làm property-
observable thật sự đồng bộ giá trị mới nhất từ worker.

---

## 4. (Đã có trong TODO.md) Race condition cache observable

`build()` dòng ~80-96: nhiều lời gọi đồng thời tới cùng observable trước khi
`observables.set(key, ...)` hoàn tất → tạo nhiều subscription trùng trên worker.
Chi tiết + hướng fix xem `TODO.md` mục "Race condition trong observable caching".

---

## Ghi chú
- Fix gốc nên làm ở mục **1** (proxy callable) — giải quyết tận gốc bug màn trắng
  của larkpanel. Khi xong, có thể đơn giản hoá `@livequery/react` `useObservable`
  (gỡ workaround) và gỡ workaround phía larkpanel (`useAccountContext`, `GoogleLogin`).
- Xem thêm `react/PROBLEMS.md` để biết phía consumer đã vá tạm những gì.
