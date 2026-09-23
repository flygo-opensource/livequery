# Quy chuẩn viết TypeScript cho Livequery

Tài liệu này chuẩn hóa phong cách đang dùng trong `core`, `client`, `react`,
`rest` để mọi package mới (`d1`, datasource, framework adapter, ...) viết
giống nhau. Khi có xung đột giữa code cũ và tài liệu này, tài liệu này thắng.
Code cũ được sửa dần khi chạm vào, không refactor hàng loạt.

## 1. Định dạng

- Không dùng dấu chấm phẩy cuối câu.
- Nháy đơn cho string. Nháy đôi chỉ xuất hiện bên trong nháy đơn hoặc trong JSON.
- Thụt lề 4 khoảng trắng. Không dùng tab.
- Dòng tối đa 120 ký tự. Import dài thì xuống dòng theo từng tên. Signature dài
  thì xuống dòng theo từng tham số.
- Tối đa một dòng trống liên tiếp giữa các khối. Hai dòng trống chỉ dùng để tách
  nhóm lớn trong file dài và phải đi kèm comment phân đoạn.
- Không để khoảng trắng cuối dòng. File kết thúc bằng một newline.
- Dấu phẩy cuối (trailing comma) trong object, array, import nhiều dòng.

```ts
import {
    BehaviorSubject,
    Subject,
    Subscription,
    finalize,
    merge,
    switchMap,
} from 'rxjs'
```

## 2. So sánh và toán tử

- Luôn dùng `===` và `!==`. Không dùng `==` kể cả so với `undefined` hay `null`.
- Dùng `x == null` là cách duy nhất được phép để kiểm tra cả `null` và
  `undefined` trong một lần; viết tường minh `x === null || x === undefined`
  nếu muốn rõ.
- Ưu tiên `??` cho giá trị mặc định. Chỉ dùng `||` khi thực sự muốn coi `0`,
  `''`, `false` là giá trị rỗng.
- Optional chaining `?.` thay cho chuỗi `a && a.b && a.b.c`.

## 3. Đặt tên

### 3.1 Ranh giới snake_case và camelCase

Quy tắc: **dữ liệu và biến dùng snake_case, hành vi dùng camelCase.**

| Phạm vi | Kiểu | Ví dụ |
| --- | --- | --- |
| Field của type wire, JSON, query string, storage | snake_case | `collection_ref`, `node_id`, `client_id`, `created_at` |
| Biến cục bộ và tham số trong function hoặc method | snake_case | `deduplicate_key`, `socket_headers`, `is_document`, `set_state` |
| Method, function, hook, callback | camelCase | `resolveDatabase`, `hidePrivateFields`, `useCollection`, `onRequest` |
| Field của class (public, `#private`, `protected _`) | camelCase | `#heartbeatMs`, `#nodeId`, `_disconnectGraceMs`, `status$` |
| Type, class, generic | PascalCase | `LivequeryRequest`, `SocketLike`, `T`, `RouteConfig` |
| Hằng số module-level | UPPER_SNAKE | `DEFAULT_TTL_MS`, `LIVEQUERY_REALTIME_PATH` |

Lý do tách như vậy: tên gọi được (method, function) đi cùng API của RxJS,
React, DOM vốn là camelCase nên đọc liền mạch. Tên trỏ đến dữ liệu (biến,
field wire) đi cùng JSON và SQL vốn là snake_case, và destructure từ wire type
không phải đổi tên.

```ts
async #call<T>(req: RestTransporterRequest) {
    const url = this.#buildUrl(req)
    const gateway_id = await this.#waitGateway()
    const socket_headers = gateway_id ? { 'x-lgid': gateway_id } : {}
    const is_document = req.ref.split('/').length % 2 === 0
    const { collection_ref, document_id } = req
    ...
}

const [state, set_state] = useState({ loading: false })
```

Ngoại lệ bắt buộc: tên phải trùng với API bên ngoài thì theo API đó, ví dụ
override `handle(ctx)`, `fetch(request)`, option `onRequest` của thư viện.

### 3.2 Hậu tố và tiền tố

- Stream RxJS kết thúc bằng `$`: `status$`, `data$`, `stop$`. Áp dụng cho cả
  field và biến cục bộ. Không dùng `$` làm tiền tố.
- Field private của ECMAScript bắt đầu bằng `#`. Field `protected` dành cho
  subclass bắt đầu bằng `_`.
- Field metadata phía client không gửi lên server bắt đầu bằng `_`:
  `_adding`, `_prev`, `_selected`. Server strip mọi field bắt đầu bằng `_`.
- Type guard bắt đầu bằng `is` hoặc `has`: `isPingFrame`, `isObservableLike`, `hasPipe`.
- Factory trả về object bắt đầu bằng `create`: `createNode`, `createRoutes`.
- Tham số không dùng bắt đầu bằng `_`: `(_ref, id) => ...`.

### 3.3 File và thư mục

**Một file chỉ có một `export class` hoặc một `export function`.** Số lượng
`export type` không giới hạn. Hàm và class phụ dùng riêng trong file thì không
export.

- Tên file trùng tên export đó: `MongodbRealtime.ts` export `MongodbRealtime`,
  `hidePrivateFields.ts` export `hidePrivateFields`.
- Type đi kèm một class hoặc hàm (options, result, event) đặt cùng file với nó.
  Type dùng chung cho nhiều file trong package đặt ở `types.ts`, file này chỉ
  có `export type`.
- Hằng số module-level dùng chung đặt ở `const.ts`.
- Hàm tiện ích nằm trong `helpers/`, mỗi hàm một file.

**Mỗi thư mục có `index.ts` re-export mọi export nằm ngang hàng với nó.**

- `index.ts` chỉ chứa `export * from './X.js'`, `export { X } from './X.js'` và
  `export type { ... } from './X.js'`. Không chứa logic, không khai báo mới.
- Thư mục con có `index.ts` riêng; `index.ts` cha re-export thư mục con qua
  `export * from './helpers/index.js'`.
- `index.ts` dành cho người dùng bên ngoài thư mục. Các file trong cùng thư mục
  import thẳng nhau, không đi qua `index.ts`, để tránh vòng lặp import.
- Export chỉ dùng nội bộ package nhưng cần qua nhiều thư mục thì vẫn re-export
  qua `index.ts`; không có khái niệm "export ẩn". Thứ không muốn lộ ra ngoài thì
  không export.
- Import nội bộ luôn có đuôi `.js` vì output là ESM: `from './Socket.js'`.

```text
src/
├── index.ts                 # export * from './WebsocketGatewayBase.js' ...
├── types.ts                 # chỉ export type
├── const.ts
├── WebsocketGatewayBase.ts  # export class WebsocketGatewayBase + type WebsocketGatewayOptions
├── LivequeryRequestParser.ts
└── helpers/
    ├── index.ts             # export * from './hidePrivateFields.js' ...
    ├── hidePrivateFields.ts # export function hidePrivateFields
    └── parseJson.ts         # export function parseJson
```

Code hiện tại còn file nhiều hàm (`filterDocs.ts`) và thiếu `helpers/index.ts`.
Tách dần khi chạm vào file đó, không tách hàng loạt.

## 4. Kiểu dữ liệu

### 4.1 `type` thay `interface`, union thay `enum`

- Mọi contract, kể cả contract có method, viết bằng `type`. Chỉ dùng `interface`
  khi cần `extends` một class hoặc khi cần declaration merging.
- Không dùng `enum`. Dùng union literal và, nếu cần lặp, một mảng `as const`.

```ts
export type UpdatedDataType = 'added' | 'removed' | 'modified'

export type LivequeryStorage = {
    get<T extends Doc>(ref: string, id: string): Promise<T | null>
    flush(): Promise<void>
}
```

### 4.2 Generic

- Generic một chữ cho type entity: `T`. Generic nhiều ký tự PascalCase khi có ý
  nghĩa: `RouteConfig`, `Response`.
- Ràng buộc entity bằng `T extends Doc` hoặc `T extends LivequeryBaseEntity`.
- Không để generic chỉ dùng cho type hint khi có thể suy ra.

### 4.3 `any` và `unknown`

- Dữ liệu đến từ ngoài (JSON parse, event từ socket, body request) nhận vào là
  `unknown` rồi thu hẹp bằng type guard.
- `Record<string, any>` được phép cho payload mở mà package không kiểm soát
  (body, query, context).
- `as any` chỉ được phép ở ranh giới tương tác với API bên ngoài hoặc khi
  TypeScript không thể biểu diễn. Mỗi `as any` phải có comment một dòng nói vì
  sao, trừ trường hợp `(e as any)?.code` trong khối `catch`.
- Không dùng `!` (non-null assertion) nếu có thể thay bằng guard. Nếu dùng,
  phải có comment lý do.

### 4.4 Type wire là nguồn sự thật

- Type đi qua mạng khai báo một lần ở `@livequery/core` và được import, không
  copy sang package khác.
- Khi client cần biến thể khác của cùng type, dùng `Pick`, `Omit`, `Partial`
  hoặc intersection trên type gốc.

## 5. Class

### 5.1 Encapsulation

- Field và method nội bộ dùng `#private` của ECMAScript, không dùng `private`
  của TypeScript. Ngoại lệ duy nhất: `constructor(private readonly config: X)`
  để rút gọn khi config không cần xử lý thêm.
- `readonly` cho mọi field không gán lại sau constructor.
- `protected _field` chỉ khi thiết kế để subclass truy cập.
- Public API của một object reactive là `public readonly` Subject hoặc
  BehaviorSubject, không expose setter.

```ts
export class ChangeFeed<T> extends Observable<ChangeEvent<T>> {
    readonly #events = new Subject<ChangeEvent<T>>()
    readonly #status$ = new BehaviorSubject<ChangeFeedStatus>('not_ready')
    readonly status$ = this.#status$.asObservable()

    #closed = false

    constructor(options: ChangeFeedOptions) {
        super(subscriber => this.#events.subscribe(subscriber))
        ...
    }
}
```

### 5.2 Thứ tự trong class

1. Field `readonly` public
2. Field `#private` và `protected`
3. Field có thể gán lại
4. `constructor`
5. Method public
6. Method `protected` hoặc adapter hook
7. Method `#private`

Tách nhóm method private bằng comment phân đoạn:

```ts
    // ── Internal ───────────────────────────────────────────────────────────────
```

### 5.3 Lifecycle

- Class giữ tài nguyên (socket, timer, subscription) phải có `close()` hoặc
  `destroy()` idempotent. Gọi hai lần không ném lỗi.
- Gom mọi subscription vào một `Subscription` cha rồi `unsubscribe()` trong
  `close()`.
- Timer phải được `clearTimeout` hoặc `clearInterval` trong `close()` và gọi
  `.unref?.()` nếu chạy trên Node.
- Dùng `using` với `Symbol.dispose` cho lock có phạm vi hàm.

## 6. Hàm và luồng điều khiển

- Hàm module-level dùng `function` khi có tên và được export hoặc hoist. Arrow
  function cho callback và cho biến cục bộ. Hàm gán vào biến cục bộ vẫn đặt
  camelCase vì nó là hành vi: `const startQuery = () => ...`.
- Guard clause và return sớm. Hạn chế `else`. Lồng nhau tối đa 3 mức.
- Một hàm làm một việc. Hàm dài hơn khoảng 60 dòng nên tách.
- `cond && fn()` được phép cho một side effect ngắn trên một dòng. Không nối
  nhiều `&&` hoặc `&&` với `?:` trong cùng một statement.
- Ternary chỉ để chọn giá trị, không để chọn side effect. Viết `if` thay cho
  `x ? set.add(id) : set.delete(id)`.
- `for (const ... of ...)` cho vòng lặp có side effect hoặc có `await`.
  `map`, `filter`, `reduce` cho biến đổi thuần.
- `reduce` chỉ khi kết quả là một giá trị tích lũy. Không dùng `reduce` với
  spread để build object hoặc mảng trong vòng lặp vì tốn O(n²); dùng
  `Object.fromEntries`, `Map`, hoặc mutate một biến cục bộ.

```ts
// Nên
const by_type = new Map<UpdatedDataType, DataChangeEvent[]>()
for (const change of changes) {
    const list = by_type.get(change.type) ?? []
    list.push(change)
    by_type.set(change.type, list)
}

// Không nên
const by_type = changes.reduce((p, c) => ({ ...p, [c.type]: [...(p[c.type] ?? []), c] }), {})
```

## 7. Bất đồng bộ và RxJS

### 7.1 Khi nào dùng gì

- `Promise` và `async/await` cho thao tác một lần có kết thúc: gọi HTTP, ghi
  storage, đọc file.
- RxJS cho luồng nhiều giá trị theo thời gian: socket, subscription, state
  thay đổi, retry có backoff.
- Không bọc Promise đơn lẻ vào Observable chỉ để dùng operator.

### 7.2 Viết pipeline

- Mỗi operator một dòng. Pipeline dài hơn khoảng 8 operator phải tách thành
  hàm có tên hoặc custom operator.
- Mọi subscription dài hạn phải có điều kiện kết thúc: `takeUntil(stop$)`,
  gom vào `Subscription` cha, hoặc `finalize` dọn tài nguyên.
- `shareReplay` luôn kèm `{ bufferSize, refCount: true }` trừ khi cố ý giữ
  cache sống mãi và có comment.
- Subject dùng làm tín hiệu (lock, stop) đặt tên theo ý nghĩa và có hậu tố
  `$`: `stop$`, `adding$`.
- Không ném lỗi bên trong `map` để điều khiển luồng. Dùng `throwError` hoặc
  `catchError` tường minh.

### 7.3 Promise

- Promise bị bỏ (fire and forget) phải có `.catch(...)`. Không để unhandled
  rejection: `this.#discovery.broadcast(m).catch(e => console.error(e))`.
- `Promise.all` khi các thao tác độc lập. Vòng `for await` khi cần thứ tự.
- Timeout bằng `AbortController` cho `fetch`, bằng `Promise.race` với timer
  cho thao tác khác. Luôn clear timer trong `finally`.

## 8. Lỗi

### 8.1 Một hình dạng lỗi

Mọi lỗi có thể đến tay người dùng API hoặc client là object phẳng:

```ts
export type LivequeryError = {
    code: string
    message: string
    status?: number
}
```

- `code` là UPPER_SNAKE ổn định để client so sánh: `NOT_FOUND`,
  `INVALID_CURSOR`, `NETWORK_ERROR`. Không dùng PascalCase hay camelCase.
- `message` dành cho người đọc, có thể đổi mà không phá client.
- `status` chỉ có ở phía server để adapter HTTP map sang mã trả về.
- Server ném object này trực tiếp: `throw { status: 404, code: 'NOT_FOUND', message: 'Document not found' }`.
- Lỗi lập trình (gọi sai API, state không hợp lệ) ném `new Error(...)`.

### 8.2 Bắt lỗi

- `catch (e)` rồi chuẩn hóa về `LivequeryError` tại một chỗ duy nhất của
  package, ví dụ `toLivequeryError(e)`. Không lặp chuỗi
  `e?.code || e?.name || 'UNKNOWN_ERROR'` ở nhiều nơi.
- `tryCatch` trả về tuple `[error, data]` được dùng khi hàm gọi muốn tiếp tục
  xử lý sau lỗi thay vì dừng. Nếu chỉ cần ném lại thì dùng `try/catch` thường.
- Không nuốt lỗi im lặng. `catch {}` rỗng phải có comment giải thích, ví dụ
  `catch { /* dead socket */ }`.

## 9. Module và import

- `import type` cho import chỉ dùng làm type. Inline `type` trong import hỗn
  hợp: `import { Subject, type Observable } from 'rxjs'`.
- Thứ tự import: package bên ngoài, rồi package workspace `@livequery/*`, rồi
  file nội bộ. Cách nhau một dòng trống nếu file có nhiều import.
- Trong cùng thư mục, import thẳng file, không qua `index.ts`. Sang thư mục
  khác hoặc package khác thì import qua `index.ts` của thư mục đó.
- Không đọc `process.env` trong thân class hoặc hàm. Đọc một lần ở `const.ts`
  với guard `typeof process !== 'undefined'` và cho phép override qua options.
- Package dùng được trên edge (Workers) không import `node:*`, `ws`, `dgram`.
  Phần phụ thuộc runtime nằm ở package adapter riêng.

## 10. Comment và tài liệu

- Comment giải thích vì sao, không giải thích cái gì. Code phải tự nói cái gì.
- Bắt buộc comment ở: workaround cho bug, thứ tự thao tác quan trọng, giới
  hạn của runtime, quyết định có thể trông sai với người đọc sau.
- JSDoc `/** */` cho class public, method public và option có ý nghĩa không
  hiển nhiên. Không JSDoc cho method private hoặc hàm tự giải thích.
- Header file cho adapter runtime có ví dụ dùng ngắn như `BunWebsocketGateway`.
- Comment viết bằng tiếng Anh trong source. Tài liệu `.md` viết bằng tiếng Việt.
- Không để code bị comment-out. Xóa, git giữ lịch sử.
- Không dùng `TODO` trong source. Ghi vào `TODO.md` của package hoặc issue.

## 11. Dữ liệu và bất biến

- Không mutate tham số đầu vào. Trả về object mới bằng spread.
- State nội bộ của class được mutate tại chỗ là bình thường, không cần spread
  nếu không có ai giữ tham chiếu cũ.
- Khi emit qua Subject, emit object mới để subscriber so sánh tham chiếu được.
- `Map` và `Set` thay cho object làm dictionary khi key động.

## 12. Runtime guard

- Kiểm tra khả năng runtime bằng `typeof X !== 'undefined'` tại điểm dùng:
  `WebSocket`, `window`, `process`, `Bun`, `WebSocketPair`.
- Cho phép override hành vi auto-detect qua option tường minh, ví dụ `ssr`.
- Dùng API Web chuẩn (`fetch`, `Request`, `Response`, `URL`, `btoa`,
  `crypto.randomUUID`) thay cho API riêng của Node khi có thể.

## 13. Test

- Dùng `bun:test` với `describe`, `test`, `expect`. Không dùng `it`.
- Tên test là một câu mô tả hành vi, viết thường, có thể dùng dấu gạch ngang
  dài để tách điều kiện và kết quả:
  `test('persist: false — items populated in constructor, storage untouched')`.
- Helper tạo fixture đặt tên `makeX`: `makeStorage`, `makeClient`,
  `makeTransporter`. Đặt ở đầu file hoặc trong `tests/helpers.ts`.
- Tách nhóm test bằng comment phân đoạn `// ─── seed ─────`.
- Test đơn vị không chạm mạng hay database thật. Test E2E đặt tên
  `*.e2e.test.ts` và đọc cấu hình từ biến môi trường có giá trị mặc định.
- Helper chờ bất đồng bộ đặt tên `tick(ms)`.

## 14. Checklist trước khi mở PR

- [ ] Không có `==`, `!=`, dấu chấm phẩy, tab, dòng trên 120 ký tự.
- [ ] Field wire và biến cục bộ snake_case, method và function camelCase.
- [ ] Mỗi file chỉ một `export class` hoặc `export function`; thư mục mới có `index.ts`.
- [ ] Không có `interface` hay `enum` mới khi `type` và union đủ dùng.
- [ ] Mọi `as any` và `!` có comment lý do.
- [ ] Class giữ tài nguyên có `close()` idempotent.
- [ ] Mọi subscription RxJS có đường kết thúc.
- [ ] Lỗi trả về đúng hình `{ code, message, status? }` với `code` UPPER_SNAKE.
- [ ] Không có code comment-out, không có `TODO` trong source.
- [ ] Type wire không bị copy sang package khác.
- [ ] `bun run build` và `bun run test` pass.
