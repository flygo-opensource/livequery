# TODO

Notes to revisit before the next compatibility pass.

## Bugs (fix trước khi release)

- [x] **`:or` filter check sai**: FIXED — `#parse_conditions` đã tách thành `#build_match` đệ quy, sinh `$match` đơn với `$and`/`$or`/`$nor` hợp lệ. Test: `MongoQuery.test.ts` (`:or`, `:not`, `:and`, combo).
- [x] **`:like` không escape regex** — FIXED: thêm `#escape_regex`, `$regex` dùng input đã escape + `$options: 'i'` (case-insensitive). Test: "`:like` escapes regex metacharacters".
- [x] **Offset paging (`:page`) silent trả rỗng** — FIXED: `#build_offset_paging` đã implement `$facet` (skip/limit + total + paging metadata); sửa luôn lệch key `req.options['page']` → `req.options[':page']` ở `query()`. Test: "offset paging (`:page`) skips and limits".
- [x] **Write response không normalize** — FIXED: `#put`/`#patch`/`#del` trả `{ item: { id, ...data } }` qua helper `#writtenItem` (bỏ operator `$set`/`$inc`). (`#post` vốn đã chuẩn.) Test bổ sung assertion return cho put/delete.
- [x] **`reslover` typo trong SmartCache** — FIXED: đổi tên tham số thành `resolver` (cosmetic, không đổi hành vi).

## Filter Compatibility With `@livequery/client`

- Use `@livequery/client` `LivequeryInlineFilters` as the public filter contract for this datasource.
- Keep MongoDB-specific filters as extensions only when needed, such as `field:eq-oid`, `field:neq-oid`, `:search`, and `::summary`.
- Add support for `field:boolean` with values `"true"`, `"false"`, `"not-true"`, and `"not-false"`.
- Add support for `field:null` with values `"null-only"` and `"not-null"`.
- Add support for `field:include` for array fields.
- Keep existing Mongo-only aliases `field:eq-boolean`, `field:neq-boolean`, `field:eq-null`, and `field:neq-null` only for backward compatibility if possible.
- Update `field:in` and `field:nin` so they accept both real arrays and JSON-encoded arrays.
- Make `field:like` match client semantics: case-insensitive substring search. Escape regex input before building MongoDB `$regex`.
- Document any remaining intentional difference between local client filtering and MongoDB server filtering.

## Logical Filters

- Pipeline shape corrected: `:and`/`:or`/`:not` now compile to a single `$match` with `$and`/`$or`/`$nor` query operators (no more invalid `$expr` + pipeline-stage operands).
- Semantics: `:and` = AND of nested group, `:or` = OR over the group's conditions, `:not` = `$nor`. Tests cover these in `MongoQuery.test.ts`.
- Still verify deeply-nested logical combinations against a real MongoDB server before documenting as stable.

## Pagination

- Decide whether `:page` offset paging should be implemented or explicitly unsupported.
- Current cursor paging is the active path; offset paging currently returns an empty pipeline.
- Check `MongoQuery` currently looks at `req.options['page']` in one place while other paging options use colon-prefixed keys.

## ObjectId Handling

- Keep `objectIdFields` because this package has no Mongoose schema introspection.
- Consider nested ObjectId conversion for dotted paths or nested write bodies.
- Keep `field:eq-oid` and `field:neq-oid` as MongoDB-specific extensions.
- Add tests for invalid ObjectId strings and expected fallback behavior.

## Query Pipeline

- Verify `$text` search behavior against a real MongoDB server, including index requirements and error shape.
- Verify cursor paging with real MongoDB, especially `$topN`, `$bottomN`, `:before`, `:after`, and `:around`.
- Review summary aggregation keys. Current behavior keeps keys such as `::totals` in facet output.
- Decide whether summary keys should strip the `::` prefix in a future breaking change.

## MongodbCollection API

- [x] **Constructor nhận `CollectionDef<T>` thay vì string** — DONE: thêm `CollectionDef<T>` class (với phantom field `declare _type: T` cho inference) và `defineCollection<T>()` factory. Constructor cũ nhận `(db, collectionName: string, defaults?)` đã bỏ hoàn toàn.
  ```ts
  const OrdersDef = defineCollection<Order>({ collection: 'orders', defaults: () => ({ active: true }) })
  new MongodbCollection(db, OrdersDef)
  ```
- Consider whether `CollectionDef` should carry index hints or schema metadata in the future.

## Core Integration

- Keep `init(routes)`, `init(config, routes)`, `handle(ctx)`, and `query(req, options)` working.
- Keep route lookup by `METHOD path` and path-only fallback.
- For dynamic routes, `ctx.request.ref` must be the route pattern, for example `/products/:id`.
- Consider whether `@livequery/core` should become a peer dependency because generated declaration files reference its types.

## Tests

- Current tests use Bun and mocked MongoDB collections; they do not require a real MongoDB server.
- Add optional integration tests behind `MONGO_URL` for real aggregation execution.
- Cover client-compatible filters after MongoQuery is aligned with `LivequeryInlineFilters`.
- Keep `npm test` mapped to `bun test`.

## Packaging

- Keep `node_modules` and `build` ignored by git.
- Consider excluding `build/tsconfig.tsbuildinfo` from published files if package output should be cleaner.
- Keep TypeScript `NodeNext` local imports with `.js` extensions.
