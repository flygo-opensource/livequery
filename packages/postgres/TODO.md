# TODO

Status notes for `@livequery/postgres`. This adapter mirrors `@livequery/mongodb` but
targets raw PostgreSQL tables via a node-postgres-shaped `query(text, values)` executor.

## Verified (đã kiểm chứng trên PostgreSQL 18.4 thật)

- [x] **Datasource contract** — `init(routes)` / `handle(ctx)` / `query(req, options)` khớp bản
  mongo (cùng error code, cùng response shape, `METHOD path` + path-only fallback).
- [x] **CRUD writes** — `INSERT/UPDATE/DELETE ... RETURNING *`; operator body `$set/$inc/$dec/$mul/$unset`.
- [x] **Reads** — filters (`eq/ne/lt/lte/gt/gte/in/nin/like/eq-number/eq-boolean/eq-null/eq-oid…`),
  logical `:and/:or/:not`, `field:sort`, `:limit`, `:search` (qua `searchFields`).
- [x] **Pagination** — cursor (default, `:after`, `:before`, `:around`, keyset OR-of-AND cho
  sort lệch chiều) + offset (`:page`).
- [x] **Summary `::name`** — `sum/avg/max/min/count/distinct`, group-by, inline match; `sum/avg`
  cast `::float8` để trả JS number.
- [x] **idField** — map `id` ↔ cột PK vật lý trên read/write.
- [x] **Anti-injection** — value luôn qua `$n`; identifier validate `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- [x] **searchFields per-route** — không cache nhầm vào table descriptor (bug đã sửa).
- [x] **Realtime** — `LISTEN/NOTIFY` + `triggerSql`, fan-out nested ref + array membership,
  auto-reconnect (factory + rxjs `retry` backoff). Verified bằng `tests/live-realtime.ts`
  (added/modified/removed, nested ref, array fan-out, reconnect sau `pg_terminate_backend`).

Tests: `bun test` (21 unit, mocked pg) + `tests/live.ts` (35 live) + `tests/live-realtime.ts`
(8 live). Live tests cần `DATABASE_URL` và bị bỏ qua bởi `bun test` (không phải `*.test.ts`).

## Remaining (tùy nhu cầu — không phải bug)

- [ ] **Wire vào mesh** — đăng ký adapter ở nơi `@livequery/honojs` / `nestjs` / `rest` khởi tạo
  datasource, nếu muốn dùng drop-in thay cho mongo.
- [ ] **Publish metadata** — soát `version` và `repository.url` trước `npm publish --access public`.
- [ ] **Numeric/bigint trong item rows** — node-postgres trả về dạng **string** (mặc định, tránh
  mất precision). Cân nhắc option `numericFields`/`castNumbers` hoặc hướng dẫn set `pg.types`
  parser ở phía caller. Hiện cố ý để mỏng giống mongo.
- [ ] **jsonb write helper** — option `jsonbFields` để `JSON.stringify` + `::jsonb` cho mảng
  (pg mặc định serialize mảng JS thành array literal, không phải jsonb).
- [ ] **Cursor trên cột timestamp/date** — hoạt động qua cast ngầm; nên thêm test riêng.
- [ ] **Realtime `_`-prefixed fields** — bản mongo strip field bắt đầu bằng `_` trong reformat;
  bản postgres hiện giữ nguyên (lệch nhẹ, cân nhắc đồng bộ).

## Compatibility rules (giữ nguyên khi sửa)

- Không thêm ORM. Giữ raw-SQL.
- Không reintroduce `@livequery/types`; dùng `@livequery/core` cho core-facing types.
- Không import trực tiếp từ `pg` trong source (peer dep optional; build không cần `@types/pg`).
- Mọi identifier qua `ident()`/`qualifiedTable()`; mọi value qua `Sql.param()`.
