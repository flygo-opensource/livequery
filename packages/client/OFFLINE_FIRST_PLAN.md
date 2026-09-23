# Kế hoạch offline-first cho `@livequery/client`

Trạng thái: **đã duyệt 2026-09-23, đã implement đủ 6 increment trên nhánh `worktree-offline-first`**
(mỗi increment một commit). Những chỗ làm khác kế hoạch ghi ở mục "Sai khác so với kế hoạch" cuối file.

- [x] Increment 1 — Sửa write-path (tiên quyết)
- [x] Increment 2 — `LivequeryIndexedDBStorage` + conformance suite
- [x] Increment 3 — Outbox bền vững + drain
- [x] Increment 4 — Conflict rebase
- [x] Increment 5 — Refetch khi reconnect
- [x] Increment 6 — Test & docs chốt sổ

## Context

`@livequery/client` hiện là optimistic-UI client có cache, chưa phải offline-first:

- Chỉ có `LivequeryMemoryStorage` — reload tab là mất sạch cache, cờ pending, document local-only.
- Các cờ `_adding_error`/`_updating_error`/`_deleting_error` được ghi nhưng **không ai đọc lại**:
  ghi lúc mất mạng là kẹt vĩnh viễn, không retry, không replay khi có mạng trở lại.
- Không có conflict resolution — `ConflictResolverFunction` export từ `LivequeryClient.ts:29`
  nhưng không nối vào đâu; realtime `modified` ghi đè thẳng lên edit local đang bay (lost update).
- Client không tự refetch khi reconnect (xem mục "Realtime drops updates across a reconnect"
  trong `todo.md` gốc).

Phạm vi v1 đã chốt: **đầy đủ phía client, không đụng server** — IndexedDB + outbox + replay +
conflict rebase "field local thắng tới khi push xong" + refetch-on-reconnect, kèm 3 bug
write-path tiên quyết. Phần đọc của client (một stream transporter mang cả HTTP result lẫn
realtime delta, storage được hâm ở mọi mode) là nền tốt — mọi việc dưới đây nằm ở phần ghi và
phần phục hồi.

## Increment 1 — Sửa write-path (ship độc lập được)

1. **Strip `id` khỏi body ghi** — `packages/rest/src/RestTransporter.ts:328`
   (`#stripPrivateFields`): bỏ thêm `k === 'id'`. Hiện client POST/PATCH kèm `id: "local:..."` →
   mọi schema `z.strictObject` (cả hai example đang ship) trả 400 `VALIDATION_FAILED`.
2. **Sửa lock `#adding`** — `LivequeryClient.ts:68,388-394`: Map theo `collection_ref` nên hai
   add đồng thời đè/xoá nhầm lock của nhau → realtime echo hết bị hoãn khi add thứ hai còn bay.
   Thay bằng helper refcount mới `packages/client/src/helpers/AddLock.ts`:
   `acquire(ref)` trả disposable (count++), `pending(ref)` emit khi count về 0.
   `#query` (:100) đổi từ `#adding.get(ref)` sang `pending(ref)`.
3. **Sửa ngữ nghĩa `_prev` ở server-first update** — `LivequeryClient.ts:508` đang gán
   `_prev: doc` (giá trị MỚI, kèm cả `id`). Đổi thành đọc `storage.get()` lấy giá trị cũ, loại
   `id` khỏi tập key. `_prev` phải là "field user sửa + giá trị TRƯỚC khi sửa" — Increment 4
   đứng trên định nghĩa này.

Test: thêm route có `validator()` schema strict vào `tests/helpers/servers.ts` + assert
add/update trong `tests/helpers/client-suite.ts` (hiện server e2e không validate — chính là
điểm mù để lọt bug 1); unit test hai add đồng thời cho AddLock.

## Increment 2 — `LivequeryIndexedDBStorage`

File mới `packages/client/src/LivequeryIndexedDBStorage.ts`, implement `LivequeryStorage`, raw
IndexedDB, không thêm runtime dependency:

- 1 DB (tên config được, mặc định `livequery`), 1 objectStore `docs`, keyPath composite
  `[collection, id]`, index `by_collection`. Không dùng store-per-collection vì IDB chỉ tạo
  store lúc version-upgrade — collection ref sinh động lúc runtime.
- `query()`: đọc cả dải theo index (`IDBKeyRange.only`) rồi lọc/sort bằng
  `helpers/filterDocs.ts` **có sẵn** — parity 100% với MemoryStorage, một nguồn ngữ nghĩa query
  duy nhất. Paging keys bỏ qua y như hiện tại.
- `update()` hỗ trợ đổi id (xoá key cũ + put key mới, **cùng một transaction readwrite**) —
  Increment 3 bắt buộc cần cho remap `local:` id.
- SSR-safe: `typeof indexedDB === 'undefined'` → degrade sang MemoryStorage nội bộ.
- Export từ `index.ts`. DevDep mới: `fake-indexeddb` (chỉ test).

**Storage là seam đa nền tảng (chủ đích thiết kế từ đầu)** — mỗi môi trường một adapter, core
không đổi; outbox/rebase/replay tự bền vững theo adapter. Ma trận môi trường:

| Môi trường | Adapter | Nền | Ghi chú độ bền |
| --- | --- | --- | --- |
| Chrome/Edge/Firefox desktop | `LivequeryIndexedDBStorage` (increment này) | IndexedDB | Gọi `navigator.storage.persist()`; quota ~60% disk/origin |
| Android — Chrome web/PWA | cùng adapter IDB | IndexedDB | Persist thường tự được cấp; KHÔNG có SharedWorker → topology A + locks |
| iOS — Safari/PWA web | cùng adapter IDB | IndexedDB | **Yếu nhất**: ITP evict ~7 ngày không dùng; PWA home-screen đỡ hơn; outbox có thể mất — docs nói thẳng |
| React Native iOS + Android | `@livequery/storage-mmkv` (package mới, phase sau) | react-native-mmkv | Key `collection/id` → JSON, query = prefix-scan + filterDocs — cùng chiến lược parity với IDB. Loại AsyncStorage (chậm, ~6MB Android) |
| RN dữ liệu lớn (>10k docs) | `@livequery/storage-sqlite` (phase sau) | op-sqlite / expo-sqlite | Mở đường đẩy filter xuống index thật thay vì lọc RAM |
| Chrome extension MV3 | adapter IDB dùng ngay trong service worker | IndexedDB | SW bị kill ~30s idle → boot-scan resume của outbox là bắt buộc |
| Hybrid WebView (Capacitor/Cordova) | IDB chạy được; muốn chắc thì bridge SQLite native | — | Data trong WKWebView có thể bị OS dọn |
| Node/Bun (SSR/test) | `LivequeryMemoryStorage` / degrade tự động | RAM | Không cần bền |

Quyết định đóng gói: adapter mang native dependency (MMKV, SQLite) tách package riêng với peer
dependency tương ứng — không nhét vào `@livequery/client`, app web không được vác peer dep
native. IDB là raw browser API, zero dep → ở lại trong client làm mặc định web:

```
@livequery/client           ← interface + Memory + IDB (zero dep, web mặc định)
@livequery/storage-mmkv     ← peer dep: react-native-mmkv       (phase sau)
@livequery/storage-sqlite   ← peer dep: op-sqlite / expo-sqlite (phase sau)
```

Vì thế:

- **`defineStorageConformanceSuite(factory)`**: bộ test parameterized ghim contract adapter
  (update đổi id, add sinh `local:` uuid khi thiếu id, doc là plain JSON structured-cloneable,
  ngữ nghĩa filter qua filterDocs). Memory + IDB cùng chạy qua suite này trong repo. **Export
  công khai** (entry `@livequery/client/testing`) để package adapter — kể cả người ngoài viết
  cho môi trường mới — chạy cùng một bộ chuẩn thay vì đọc source đoán contract.
- Mọi logic offline (outbox/conflict/replay) tuyệt đối storage-agnostic — chỉ gọi 6 method của
  interface. Outbox lưu qua interface nên RN có outbox bền vững ngay khi có adapter bền vững.
- Docs ghi rõ: iOS Safari/WKWebView có ITP eviction (~7 ngày không dùng) → gọi
  `navigator.storage.persist()` và coi storage là cache có thể mất; extension MV3 service worker
  bị kill sau ~30s idle → drain phải resumable từ boot-scan.

Trade-off v1: `query()` đọc cả collection rồi lọc RAM — ổn tới ~10k docs (ngang MemoryStorage),
tối ưu bằng IDB index phụ/cursor là việc sau, không đổi interface.

## Increment 3 — Outbox bền vững + drain

File mới `packages/client/src/LivequeryOutbox.ts`. Entry lưu **qua chính `LivequeryStorage`**
dưới ref dành riêng `__livequery_outbox` — bền vững theo storage đã chọn, không đổi interface:

```ts
type OutboxEntry = {
  id: string          // uuidv7 — time-ordered → sort theo id = FIFO
  collection_ref: string
  op: 'add' | 'update' | 'delete'
  doc_id: string
  payload: Record<string, any>   // add: doc đầy đủ; update: field đã đổi
  context?: Record<string, any>
  attempts: number
  last_error?: { code: string, message: string }
}
```

- **Tín hiệu kết nối**: thêm optional `status$?: Observable<{connected: boolean}>` vào
  `LivequeryTransporter`; `RestTransporter` map từ Socket state (`connected`,
  `distinctUntilChanged`). Non-breaking với transporter khác.
- **Điểm enqueue**: trong `#push` (`LivequeryClient.ts:396-404, 418-433, 453-459`), gate
  `!server_first && isRetryable(e)` với `isRetryable = code === 'NETWORK_ERROR' || HTTP_5xx`:
  - Retryable → enqueue, **giữ nguyên** `_adding` / `_prev`+`_updating` / `_deleting`
    (⚠️ `:455-459` hiện xoá `_prev` khi lỗi — phải bỏ, rebase cần nó), thêm cờ `_queued: true`
    vào `DocMetadata`.
  - HTTP_4xx (request sai — validation, 403) → **không enqueue**, giữ hành vi cờ lỗi hiện tại.
  - **Server-first vẫn throw, không bao giờ enqueue** — contract là "trả lời nghĩa là server đã
    xác nhận". App offline-first dùng `local-first`; docs ghi rõ (lưu ý `#defaultMode()`:
    cache-first mặc định mutation về server-first).
- **Drain**: FIFO nghiêm ngặt, 1 in-flight, backoff 2s→30s, `attempts`/`last_error` persist.
  Trigger: boot scan (`start()` fire-and-forget từ constructor — reload/SW-kill xong tự tiếp
  tục), sau mỗi enqueue, sự kiện `'online'` trên `globalThis` (feature-detect, KHÔNG tham chiếu
  `window` — client phải chạy được trong SharedWorker/extension SW), `status$` false→true.
  Thành công → tái dùng đường clear-flag + broadcast của `#push` (tách thành
  `#confirmAdd/#confirmUpdate/#confirmDelete` dùng chung); drained add giữ AddLock (Increment 1).
- **Remap local id**: add drain xong lấy id thật → `storage.update` đổi id (transaction đơn,
  Increment 2), broadcast `modified` (UI giữ nguyên item, chỉ id đổi), rồi **rewrite `doc_id`
  của mọi entry còn trỏ id cũ** — thiếu bước này, update xếp sau bắn vào id ma → 404.
- **Coalescing lúc enqueue** (cùng `collection_ref + doc_id`): add+update → gộp vào add;
  add+delete → xoá cả hai entry + hard-delete doc local; update+update → gộp field;
  update+delete → chỉ delete.
- Guard: `watch()` throw nếu ref là `__livequery_outbox`; quota error khi enqueue → rơi về
  đường cờ lỗi (không nuốt im lặng); `destroy()` gọi `outbox.stop()`.

## Increment 4 — Conflict rebase (field local thắng tới khi push xong)

Một điểm chặn duy nhất: vòng storage-sync trong `#query` (`LivequeryClient.ts:84-91`) xử lý MỌI
emission của transporter (kết quả query lẫn realtime) trước broadcast. Tách thành
`#ingestRemoteChange(change)`:

- `modified`/`added`: đọc `local = storage.get(ref, id)`; nếu `local._prev` →
  `rebased = { ...change.data, ...pick(local, keys(local._prev)) }`; ghi `rebased` vào storage
  VÀ trả change mang `rebased`. Downstream tự đúng theo, không sửa collection:
  `#broadcast`, merge `{...target.value, ...data}` ở `LivequeryCollection.ts:195`, và
  `#filterLocalEvents` (đọc storage — cũng thấy bản rebased).
- `local._deleting` → nuốt event `modified` (user đã quyết xoá, delete pending thắng).
- `removed` → như hiện tại (server không còn doc thì xoá thắng).
- Wire `ConflictResolverFunction` (đã export) thành `LivequeryClientConfig.conflictResolver?` —
  không truyền dùng default rebase; truyền thì resolver của app quyết
  (`{ old_document, change }` → `{ approved, document }`).
- Drain xong doc → `_prev` clear (đường confirm Increment 3) → remote thắng trở lại.

Giới hạn nói thẳng: rebase **theo field** — hai người sửa cùng một field thì người push sau
thắng field đó (resolver can thiệp được). Merge theo ký tự là đất của CRDT, ngoài phạm vi.

## Increment 5 — Refetch khi reconnect

- Lưu `last_query` vào `CollectionMetadata` mỗi lần `query()` chạy.
- Client subscribe `status$` các transporter; false→true: clear `#cache` dedupe, re-emit
  `last_query` vào `#queries$` cho mọi collection server-first/cache-first đang sống. GET chạy
  lại → dữ liệu bỏ lỡ về (đi qua `#ingestRemoteChange` nên không đè edit pending) và server
  đăng ký lại subscription qua cơ chế `x-livequery-ref` sẵn có.
- **Bắt buộc kèm**: đổi pipeline server-query (`LivequeryClient.ts:133-156`) từ `mergeMap` sang
  `groupBy(collection_id)` + `switchMap` trong từng group — không đổi thì mỗi re-query cộng
  thêm một inner stream sống song song, realtime event nhân N theo số lần rớt mạng.
  `realtime-leak.test.ts` phải vẫn xanh. **Ship cuối cùng** vì đụng hot path.
- Hệ quả UX chấp nhận ở v1: spinner nháy nhẹ khi mạng về (re-query phát loading như thường).
- Cùng tín hiệu reconnect kích cả drain outbox (chiều ghi) lẫn refetch (chiều đọc) — chạy song
  song an toàn nhờ rebase.

Đóng mục "Realtime drops updates across a reconnect, and the client never refetches" trong
`todo.md` gốc.

## Increment 6 — Test & docs

- `packages/client/tests/outbox.test.ts`: NETWORK_ERROR→success (FIFO, đủ 4 cặp coalescing,
  remap id kèm rewrite queue, clear flag + broadcast, 4xx không enqueue, **boot-scan resume**:
  client mới trên cùng storage tự drain tiếp).
- `packages/client/tests/indexeddb-storage.test.ts` (fake-indexeddb; ca đinh: update đổi id
  trong một transaction) + conformance suite chạy cho cả Memory lẫn IDB.
- `packages/client/tests/conflict-rebase.test.ts` (field local thắng, `_deleting` nuốt modified,
  custom resolver, **bản trong storage cũng rebased**), `reconnect-refetch.test.ts` (sau N lần
  reconnect vẫn đúng 1 inner stream).
- E2e offline thật trong `tests/`: server Hono in-process → tắt server → ghi local-first →
  assert optimistic UI + entry trong outbox → bật lại → assert drain xong, doc trên server, cờ
  sạch.
- `packages/client/README.md`: mục offline-first — ma trận mode × hành vi offline (nhấn:
  `server-first` throw khi offline là by design), chọn storage theo platform (cảnh báo ITP),
  semantics outbox, conflict policy.
- Giới hạn v1 ghi thành văn: multi-tab dùng `navigator.locks` bầu 1 drainer (không có thì
  last-writer-wins); `trigger()` không queue; `flush()` xoá cả outbox (cảnh báo khi queue chưa
  rỗng); rebase theo field.
- Cập nhật `todo.md` gốc: các mục write-path 1/3/5, lost-update (2), reconnect-refetch được
  đóng bởi kế hoạch này.

## Phase 2 (ngoài v1 — v1 không được chặn đường): client trong SharedWorker

> ✅ Đã làm (2026-09-23, commit `ebf791a`): `createRemoteLivequeryClient` + `@livequery/rpc`. Xem
> mục "Đồng bộ khai báo, PWA" ở cuối.

`@livequery/rpc` (SharedWorkerChannel/WorkerManager/WorkerService) + e2e
`rpc-livequery-bridge.e2e.test.ts` đã chứng minh pattern "collection sống ở worker". Topology B:
LivequeryClient (1 socket, 1 IDB writer, 1 outbox drainer) chạy trong SharedWorker, tab là UI
mỏng qua MessagePort — multi-tab tự nhiên một drainer, một WebSocket cho cả browser profile,
`client_id` sống qua reload tab (cải thiện hẳn câu chuyện grace-window trong README gốc).

Ràng buộc v1 để phase 2 cắm là chạy: không tham chiếu `window`/DOM, state nằm hết trong
client + storage. Tương thích: Chrome Android KHÔNG có SharedWorker, Safari chỉ từ 16 →
topology A (client trong tab + `navigator.locks`) là fallback vĩnh viễn, không phí công.

## Verify

1. `bun run build` toàn workspace.
2. `bun test` theo từng increment; chốt bằng full `bun run test` (507 test hiện có + test mới).
3. E2e offline: write lúc server tắt được drain sau khi server bật lại.
4. `realtime-leak.test.ts` + `ws-reconnect.e2e.test.ts` xanh sau Increment 5.

## Rủi ro

- Increment 5 đụng pipeline nóng nhất client — ship cuối, lưới test dày nhất.
- Giữ `_prev`/`_adding` sống khi queued đổi ngữ nghĩa cờ với user local-first hiện tại — nêu rõ
  trong README.
- Độ trung thực fake-indexeddb với composite key + đổi id — có test riêng.

## Sai khác so với kế hoạch

Ghi lại lúc implement (2026-09-23), để người review không phải tự dò:

1. **Mọi write local-first đều đi qua outbox**, không chỉ khi lỗi. Kế hoạch chỉ enqueue khi
   `#push` gặp lỗi retryable, nhưng như vậy một write mới lúc queue còn entry sẽ vượt mặt entry cũ
   (vỡ FIFO), và `update` trên doc `local:` đang add dở sẽ gọi `add` lần hai. Khi online thì không
   thấy khác biệt: write gửi ngay, mutation vẫn resolve bằng dữ liệu server.
2. **Entry không lưu `payload`.** Lúc gửi mới đọc từ storage: add gửi cả doc, update gửi các field
   trong `_prev`. Nhờ vậy coalescing gần như tự nhiên (entry chưa gửi luôn mang state mới nhất), và
   confirm chỉ xoá những key `_prev` mà giá trị hiện tại vẫn bằng giá trị vừa gửi — sửa tiếp trong
   lúc request đang bay không bị mất.
3. **Increment 5 không dùng `groupBy` + `switchMap`.** `switchMap` theo collection sẽ huỷ luôn stream
   realtime của trang đầu mỗi lần `loadMore`. Thay bằng `takeUntil` "query trang đầu tiếp theo của
   cùng collection": re-query (reconnect hay đổi filter) thay stream cũ, còn query phân trang giữ
   nguyên. `realtime-leak.test.ts` vẫn xanh; `reconnect-refetch.test.ts` ghim cả hai điều.
4. **Refetch không bật spinner**, và collection nhận kết quả có cờ `refetch: true` để reconcile
   (cập nhật item đang có, bỏ item không còn, giữ doc chỉ có trên máy). Local-first refetch là một
   lần đọc hết các trang (không mở thêm realtime), kèm xoá khỏi storage các doc server không còn trả;
   đọc lỗi thì không xoá gì.
5. **Test strict-schema của Increment 1 có hai lớp.** Server Hono + Map in-process
   (`tests/helpers/memoryServer.ts`, không cần Mongo; dùng luôn cho e2e offline), và — đúng như kế
   hoạch — `buildHonoMongoApp` trong `tests/helpers/servers.ts` nhận `schema` để bọc POST/PATCH bằng
   `validator()`; suite fullstack Hono giờ chạy sau `z.strictObject`.
6. **Conformance suite nhận `{ name, create, dispose?, describe, test, expect }`** thay vì chỉ
   `factory`, để chạy được với bun:test, vitest lẫn jest.
7. **`LivequeryStorage.shared?`** (optional) được thêm để chọn tên `navigator.locks` cho outbox;
   IndexedDB đặt `indexeddb:<name>`, memory storage không đặt nên không khoá.
8. `client.refetch()` và `client.outbox` là public.

Bug tìm thêm trong lúc làm, đã sửa kèm:

- Collection local-first làm mất item vừa add xong: bộ lọc tra storage theo id `local:` cũ, không
  thấy, đổi event thành `removed`.
- Xoá một doc `local:` ở local-first từng gọi `transporter.add`.
- Collection xoá nhầm item bên cạnh khi một batch có hai lần `removed` cùng id.
- Delete replay nhận 404 giờ tính là xong thay vì `_deleting_error`.

## Đối chiếu tiêu chuẩn local-first (2026-09-23)

Nguồn: 7 tiêu chuẩn của Ink & Switch ("Local-first software", 2019) và các checklist outbox /
offline-sync thực hành (thứ tự FIFO, phân loại lỗi HTTP, token lúc replay, idempotency, giới hạn
queue). ✅ = có và có test; ⚠️ = có một phần; ❌ = chưa có (ghi rõ trong README mục Limits).

| Tiêu chuẩn | Trạng thái | Bằng chứng (test) |
| --- | --- | --- |
| 1. No spinners — ghi hiện ngay, trước khi server trả lời | ✅ | `local-first-standards.test.ts` (no spinners), e2e `local-first-sync` bước 1 |
| 2. Nhiều thiết bị, đồng bộ qua server | ✅ | e2e `local-first-sync.e2e.test.ts`: 2 thiết bị hội tụ về cùng trạng thái |
| 3. Network optional — đọc khi cold start offline | ✅ | `local-first-standards.test.ts` (cold start offline) |
| 3. Network optional — CRUD offline | ✅ | `outbox.test.ts`, e2e `client-offline`, e2e `local-first-sync` |
| 3. Tự đồng bộ khi có mạng lại (backoff, `online`, `status$` reconnect) | ✅ | `outbox.test.ts` (resume), e2e `client-offline` (backoff tự chạy) |
| 3. Sống qua reload / service worker bị kill | ✅ | `outbox.test.ts` (resume), e2e `client-offline` (IndexedDB reload) |
| 3. Đọc bù sau reconnect | ✅ | `reconnect-refetch.test.ts` |
| 4. Cộng tác — sửa khác field thì merge | ✅ | `conflict-rebase.test.ts`, e2e `local-first-sync` (title của A + done của B) |
| 4. Cộng tác — cùng field | ⚠️ last-writer-wins theo field, có `conflictResolver`; không có CRDT (merge trong text/list) | `conflict-rebase.test.ts`, e2e `local-first-sync` |
| 5. The Long Now — dữ liệu ở định dạng mở, đọc được không cần app | ⚠️ JSON thuần trong IndexedDB; chưa có API export / migration schema | conformance suite (round-trip JSON) |
| 6. Bảo mật, mã hoá đầu-cuối | ❌ server đọc được dữ liệu; có thể thêm ở tầng transporter | — |
| 7. Người dùng sở hữu dữ liệu | ⚠️ bản chính nằm trên máy (local-first); không có export | — |
| Outbox: FIFO, một request đang bay | ✅ | `outbox.test.ts` (FIFO) |
| Outbox: phân loại lỗi — retry 5xx/401/408/429/mạng, bỏ 400/403/404/422 | ✅ (401 mới thêm: login hết hạn không làm mất ghi) | `local-first-standards.test.ts` (401, 403), `outbox.test.ts` (4xx, 5xx) |
| Outbox: token đọc lúc replay, không lưu trong entry | ✅ entry không chứa header; `onRequest` chạy lúc gửi | e2e `local-first-sync` (dùng `onRequest`) |
| Outbox: gộp ghi thừa | ✅ | `outbox.test.ts` (coalescing 4 cặp) |
| Outbox: trạng thái đồng bộ cho UI | ✅ cờ `_queued` trên doc + `outbox.pending$` (mới) | `local-first-standards.test.ts` (pending$) |
| Outbox: storage đầy / không ghi được queue | ✅ (mới) cờ lỗi `OUTBOX_WRITE_FAILED` trên doc | `local-first-standards.test.ts` |
| Outbox: idempotency (mất response → gửi lại tạo bản trùng) | ✅ id do client sinh (uuidv7) + server 409 khi trùng; xem mục "Id do client sinh" | `client-ids.test.ts`, e2e `client-strict-schema`, e2e `mongodb-client-ids` |
| Outbox: doc + entry trong cùng transaction | ❌ hai lần ghi storage riêng; cửa sổ crash nhỏ | — |
| Outbox: giới hạn kích thước / TTL, huỷ entry | ❌ | — |
| Nhiều tab | ⚠️ một drainer qua `navigator.locks`; tab khác không thấy xác nhận tới lần đọc sau | `outbox.test.ts` (lock) |

Việc tiếp theo đề xuất, theo thứ tự giá trị: (1) bước repair khi boot cho doc đang pending mà thiếu
entry; (2) `outbox.discard(entry_id)` + giới hạn queue; (3) Idempotency-Key cho `trigger()` action;
(4) export dữ liệu; (5) CRDT cho field text nếu có nhu cầu cộng tác thời gian thực.

## Id do client sinh — chống trùng khi retry (2026-09-23)

Quyết định (đã chốt với người dùng): client sinh id, server validate chuẩn uuidv7 và ghi thẳng vào
DB; trùng id thì server báo lỗi; bật mặc định, tắt được theo route (`clientIds: false`). Mongo lưu
id dạng BSON UUID. Đối chiếu: Firestore, CouchDB, Replicache, PowerSync, Realm đều sinh id ở client.
Đã kiểm chứng trên MongoDB 8.0.32 thật bằng `tests/scripts/mongo-custom-id.probe.ts` (12/12).

- **Core** `resolveClientId(body)`: không có id hoặc `local:…` (client cũ) → `undefined`, server tự
  sinh như trước; uuidv7 hợp lệ, timestamp không vượt quá 24h tương lai → id; còn lại → 400
  `INVALID_ID`. Hằng `ID_ALREADY_EXISTS`.
- **Mongo** `_id = new UUID(id)`; lỗi 11000 trên `_id` → 409 `ID_ALREADY_EXISTS`, index khác → 409
  `DUPLICATE_KEY`. Tra theo id nhận cả ObjectId (24 hex) lẫn UUID. Response, realtime, cursor trả
  chuỗi uuid (`fromMongoId`; `String(binary)` ra sai). **Phân trang cursor qua ranh giới kiểu**:
  `$lt/$gt` chỉ khớp cùng kiểu BSON nên collection lẫn ObjectId + UUID trước đây dừng ở ranh giới
  (test: không sửa thì chỉ thấy 7/13 doc); điều kiện trang giờ thêm `$type` của kiểu nằm phía trước.
- **D1** dùng id client làm `id`; `UNIQUE constraint failed: <table>.id` → 409. **Postgres** chèn vào
  cột khoá; `23505` trên `_pkey` → 409; `22P02` (cột khoá là serial) → 400 kèm hướng dẫn tắt.
- **honojs `validator()`** tách `id` khỏi schema check khi POST (schema strict không phải khai báo
  `id`), rồi gắn lại cho datasource tự validate. PATCH không đổi.
- **Client**: `add()` sinh uuidv7 thay `local:…`; payload add kèm `id`; "chưa lên server" nhận biết
  bằng `_adding` thay vì tiền tố. Retry nhận 409 `ID_ALREADY_EXISTS` (attempts > 0) → coi là đã tạo,
  PATCH các field hiện tại (lần gửi đầu có thể mang dữ liệu cũ hơn). 409 ở lần đầu → `_adding_error`.
  Server cũ bỏ qua id vẫn chạy: đường đổi id giữ nguyên.
- **Hệ quả tốt**: không còn đổi id sau đồng bộ; doc tạo offline tham chiếu được doc khác ngay.
- **Lưu ý**: collection Mongo lẫn hai kiểu sort theo `id` sẽ gom theo kiểu, không thuần theo thời gian.
  Client 2.x vẫn chạy (id `local:` bị bỏ qua).

## Tiến độ kiểm chứng (2026-09-23)

| Hạng mục Verify | Kết quả |
| --- | --- |
| 1. `bun run build` toàn workspace (kèm typecheck examples) | ✅ |
| 2. `bun run test` — mọi package + examples | ✅ (client 139, core 133, d1 40, postgres 27, honojs 43…) |
| 3. E2e offline: ghi lúc server tắt, drain khi bật lại (cả qua reload với IndexedDB) | ✅ `tests/client-offline.e2e.test.ts` |
| 4. `realtime-leak.test.ts` + `ws-reconnect.e2e.test.ts` | ✅ |
| Toàn bộ e2e gốc `tests/` với replica set LAN (`192.168.2.4:27018`) | ✅ 121/121, gồm hai suite fullstack client, `local-first-sync` (2 thiết bị) và `mongodb-client-ids` |

`todo.md` gốc đã cập nhật trong checkout chính (chưa commit, cùng các sửa đổi khác của bạn): mục
write-path 1, 2, 3, 5 đánh dấu đã sửa; mục "Realtime drops updates across a reconnect" ghi phần
client đã xong, phần server (replay event rơi trong grace window) vẫn mở. Mục 4 và 6 vẫn mở.

Còn lại trước khi merge: review, merge nhánh `worktree-offline-first`, xoá bản plan chưa track trong
checkout chính (nhánh đã commit file này) để git không từ chối merge.

## Đồng bộ khai báo, PWA (2026-09-23)

Tiêu chí được duyệt: (1) app chat là PWA, chạy khi mất mạng, có mạng thì tự đồng bộ và gửi tin chờ;
(2) React chỉ dùng `useCollection`, `useDocument`.

| Commit | Nội dung |
| --- | --- |
| `6534722` | Phân trang keyset trong storage (`:limit`, `:after`, `:before`) |
| `e0d0e28` | Ingest theo phiên bản: `updated_at` cũ hơn bị bỏ, `deleted_at` là tombstone |
| `3c28278` | `LivequerySync`: `mode: { scope, size, sort, keep, evict, children }` — khai báo phần giữ trên máy; tải lần đầu, delta, realtime, extend, children theo ref pattern |
| `5068ce8` | Document `livequery/status` (`connected`, `offline`, `online`, `pending`), cập nhật `{ offline }` để giả lập mất mạng |
| `ebf791a` | `useCollection`/`useDocument` tự re-render; `createRemoteLivequeryClient` cho client chạy trong SharedWorker |
| `5df5c63` | `@livequery/mongodb` `sync: true`: `updated_at`, tombstone, đọc delta — kiểm trên replica set LAN |
| `9fe8c2a` | Sửa lỗi lộ ra khi chạy trình duyệt thật: socket mới thay socket half-open, backoff reset, `synced_at` không nhảy trước catch-up, doc đang giữ nhận lại dạng `added` thì cập nhật |
| `c44c662` | Demo chat viết lại: PWA, chỉ `useCollection`/`useDocument`, 45/45 kiểm tra trình duyệt gồm cắt mạng thật (proxy tắt được) |

Kiểm chứng: client 179, react 68, rest 15, rpc 47, core 133, mongodb 66 (+1 e2e Mongo thật), honojs 43.
Demo: https://livequery-chat.global.flygo.vn.

Còn mở: socket của SharedWorker rớt (1006) mỗi lần điều hướng cả trang (tự nối lại ~2s, delta bù);
phần server của "replay event rơi trong grace window" (không cần cho scope local-first có `sync: true`).

