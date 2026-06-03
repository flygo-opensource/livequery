# Known bugs

## 1. `LivequeryCollection.initialize(ref)` — query cho ref mới bị huỷ do race timer

**Triệu chứng:** Khi một component dùng `useCollection` và **đổi `ref`** (ví dụ chuyển từ chat A sang chat B, cùng một collection instance), lần khởi tạo đầu tiên load dữ liệu bình thường, nhưng các lần đổi `ref` sau đó **không load dữ liệu mới** (danh sách trống / giữ nguyên rỗng).

**Nguyên nhân:** Trong `LivequeryCollection.initialize(ref)` (`dist/LivequeryCollection.js`), thứ tự thực thi:

```js
initialize(ref) {
  ...
  this.#timer = setTimeout(startQuery);   // (A) hẹn query cho ref MỚI
  this.#subscription?.unsubscribe();        // (B) huỷ subscription CŨ
  this.#subscription = merge(
    ...,
    this.client.watch(this.ref, ...).pipe(
      finalize(() => {                      // (C) finalize của watch CŨ
        this.#timer && clearTimeout(this.#timer);
        this.#timer = undefined;
      }),
      ...
    )
  );
}
```

Tại (B), việc `unsubscribe()` subscription cũ kích hoạt `finalize` (C) của watch cũ. `finalize` gọi `clearTimeout(this.#timer)` — nhưng `this.#timer` **đã bị ghi đè** ở (A) bằng timer của ref MỚI. Hệ quả: timer query cho ref mới bị clear → `startQuery()` **không bao giờ chạy** → không có query → collection rỗng.

Lần `initialize` ĐẦU TIÊN không có `this.#subscription` nên (B) là no-op → timer (A) sống sót → query chạy → load OK. Đó là lý do "lần đầu OK, đổi ref thì trống".

**Cách sửa đề xuất:** Tách biến timer cục bộ cho mỗi `initialize`, để `finalize` của subscription cũ không clear nhầm timer của lần khởi tạo mới. Ví dụ:

```js
initialize(ref) {
  ...
  // huỷ subscription cũ TRƯỚC khi đặt timer mới
  this.#subscription?.unsubscribe();

  const timer = setTimeout(startQuery);
  this.#timer = timer;

  this.#subscription = merge(
    ...,
    this.client.watch(this.ref, ...).pipe(
      finalize(() => { clearTimeout(timer); }),  // chỉ clear timer của CHÍNH lần này
      ...
    )
  );
}
```

Hoặc đơn giản: đảo thứ tự — gọi `this.#subscription?.unsubscribe()` **trước** khi `this.#timer = setTimeout(startQuery)`.

**Workaround phía app (đến khi vá lib):** Buộc component dùng `useCollection` remount khi `ref` đổi — `<Component key={ref} />` — để tạo `LivequeryCollection` mới đi vào nhánh first-init (không dính race).

**Phát hiện:** dự án codex-dev (Hono + livequery), màn chat — chuyển chat không load turns mới. `@livequery/client` 2.0.140.
