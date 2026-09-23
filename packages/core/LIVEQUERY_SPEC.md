# Livequery Specification

This document defines the framework-agnostic Livequery model used by `@livequery/core`.

Livequery is not a database engine and does not require any specific HTTP framework. A Livequery service can be backed by a database, an external API, an in-memory map, generated data, or any custom handler. The standard is the request model, response envelope, path grammar, action model, response item identity, and realtime update shape.

## Core Idea

Livequery maps an HTTP path to a normalized data reference called a `ref`.

Examples:

| Request path | Meaning | Ref |
| --- | --- | --- |
| `/livequery/posts` | `posts` collection | `posts` |
| `/livequery/posts/p1` | `posts/p1` document | `posts/p1` |
| `/livequery/users/u1/posts` | nested `posts` collection for user `u1` | `users/u1/posts` |
| `/livequery/users/u1/posts/p1` | nested post document `p1` for user `u1` | `users/u1/posts/p1` |

Every Livequery API path MUST start with the `livequery` route prefix. The prefix is not part of the normalized data ref.

## Request Model

A framework adapter provides a `RawRequest`, then `LivequeryRequestParser` creates a normalized `LivequeryRequest`.

Important fields:

```ts
type LivequeryRequest<I = any> = {
  keys: Record<string, any>
  path: string
  action?: string
  document_id?: string
  collection: string
  collection_ref: string
  schema: string
  schema_collection_ref: string
  ref: string
  method: string
  body: I
  query: Record<string, any>
}
```

Field meanings:

| Field | Meaning |
| --- | --- |
| `path` | Original request path, including any query string or custom action suffix supplied by the adapter. |
| `action` | Custom action verb from a `~verb` pathname suffix, when present. Undefined for normal collection/document actions. |
| `ref` | Concrete data reference for this request, such as `posts` or `posts/p1`. |
| `collection` | Last segment of `collection_ref`, such as `posts`. |
| `collection_ref` | Concrete collection containing the item, such as `posts` or `users/u1/posts`. |
| `schema` | Route-pattern collection ref preserving dynamic `:` segments, such as `users/:uid/posts`. |
| `schema_collection_ref` | Route-pattern collection ref using parameter names instead of values, such as `users/uid/posts`. |
| `document_id` | Document id when the request targets a document. Undefined for collection requests. |
| `keys` | Route parameters whose route-pattern segments begin with `:`. |
| `method` | Uppercased HTTP method. |
| `body` | Request body. The format is application-defined. |
| `query` | Parsed query parameters. Query values are not part of the path grammar. |

## Collection And Document Paths

Livequery distinguishes collections and documents by the route pattern.

The parser works from two paths supplied by a framework adapter:

- `request.path`: the actual request path, such as `/livequery/posts/p1`.
- `request.ref`: the matched route pattern, such as `/livequery/posts/:id`.

Path normalization rules:

- The first path segment must be `livequery`; parsing starts at the next segment.
- Leading, trailing, and repeated `/` separators are ignored while parsing.
- Query strings are removed before parsing path segments.
- A `~` suffix in the pathname is removed from the data ref and may be exposed as `action`.
- A `~` inside the query string is not special and remains part of the query value.
- The HTTP method is normalized to uppercase.

Route pattern rules:

- Static segments match literal collection names, such as `posts`.
- Parameter segments begin with `:`, such as `:id` or `:uid`.
- A route pattern ending with a parameter segment is document-shaped.
- The final actual segment in a document-shaped route is `document_id`.
- Intermediate parameter segments are part of the collection path, not document ids.
- `schema` preserves parameter names with `:`, while `schema_collection_ref` uses parameter names without `:` and `collection_ref` uses actual values.
- If a document-shaped route is matched without a final document id, `document_id` is undefined and the parsed ref is the available collection path. Controllers or adapters may reject that request according to their routing rules.

A collection route does not end with a document parameter:

```txt
GET /livequery/posts
ref /livequery/posts
```

Normalized request:

```ts
{
  ref: 'posts',
  collection_ref: 'posts',
  schema_collection_ref: 'posts',
  document_id: undefined
}
```

A document route ends with a parameter segment:

```txt
GET /livequery/posts/p1
ref /livequery/posts/:id
```

Normalized request:

```ts
{
  ref: 'posts/p1',
  collection_ref: 'posts',
  schema_collection_ref: 'posts',
  document_id: 'p1',
  keys: { id: 'p1' }
}
```

Nested collections and documents follow the same rule:

```txt
GET /livequery/users/u1/posts/p1
ref /livequery/users/:uid/posts/:pid
```

Normalized request:

```ts
{
  ref: 'users/u1/posts/p1',
  collection_ref: 'users/u1/posts',
  schema_collection_ref: 'users/uid/posts',
  document_id: 'p1',
  keys: { uid: 'u1', pid: 'p1' }
}
```

## Actions

The default action is derived from the HTTP method and whether the target is a collection or document.

Common conventions:

| Request | Meaning |
| --- | --- |
| `GET /livequery/posts` | Read a collection. |
| `GET /livequery/posts/p1` | Read a document. |
| `POST /livequery/posts` | Create in a collection. |
| `PATCH /livequery/posts/p1` | Update a document. |
| `DELETE /livequery/posts/p1` | Delete a document. |

Livequery core does not execute these actions by itself. A datasource or custom handler decides how to handle the normalized request.

## Custom Actions

A custom action is an application-defined verb appended to the pathname with `~`.

Syntax:

```txt
<livequery-path>~<verb>
```

Examples:

```txt
POST /livequery/posts/p1~publish
POST /livequery/posts/p1~archive
POST /livequery/posts~export
POST /livequery/users/u1/posts~reorder
```

Rules:

- Custom actions are intended to use HTTP `POST`.
- The part before `~` is parsed as the normal Livequery data ref.
- The part after `~` is the custom action verb.
- `~` is only meaningful in the pathname.
- `~` inside a query string is part of the query value and is not a custom action.
- Core parsing does not need to reject a non-`POST` custom action. Controllers, framework adapters, or datasources should report method errors for unsupported action/method combinations.

Example:

```txt
POST /livequery/posts/p1~publish
ref /livequery/posts/:id~publish
```

Conceptual normalized request:

```ts
{
  method: 'POST',
  action: 'publish',
  ref: 'posts/p1',
  collection_ref: 'posts',
  document_id: 'p1'
}
```

When adding or changing custom action support, preserve the rules above and add tests for collection actions, document actions, non-`POST` pass-through behavior, and query strings containing `~`.

## Response Envelope

Livequery response payloads are application-defined, but the top-level response envelope is standardized.

Successful responses must wrap all payloads in `data`:

```ts
type LivequerySuccessResponse<T = any> = {
  data: T
}
```

Error responses must use `error` with `message` and `code`:

```ts
type LivequeryErrorResponse = {
  error: {
    message: string
    code: string
  }
}
```

Combined shape:

```ts
type LivequeryResponse<T = any> =
  | { data: T }
  | { error: { message: string; code: string } }
```

Rules:

- A successful response must have `data`.
- A failed response must have `error.message` and `error.code`.
- Do not return successful payloads as bare top-level objects.
- HTTP status belongs to the HTTP response status, not the Livequery error body.
- A response body should not contain both `data` and `error`.
- Infrastructure responses, including API gateway errors, should use the same error envelope.

Valid success response:

```json
{
  "data": {
    "item": {
      "id": "p1",
      "title": "Hello"
    }
  }
}
```

Valid error response:

```json
{
  "error": {
    "message": "Post not found",
    "code": "DOCUMENT_NOT_FOUND"
  }
}
```

## Collection And Document Payloads

Livequery payloads are free-form except for response item identity. The following shapes are common helpers, not the only allowed payloads.

### Response Item Identity

When a response payload returns resource items, each returned item MUST include every route parameter key from `ctx.livequery.keys` as a same-name field with the same value.

This rule applies to:

- Each item in `data.items` for collection responses.
- `data.item` for document responses.
- Resource items returned by custom action payloads.

For example, a collection route:

```txt
GET /livequery/category/c1/tag/urgent/tasks
ref /livequery/category/:category_id/tag/:tag/tasks
```

returns `keys: { category_id: 'c1', tag: 'urgent' }`, so each returned task item MUST include `category_id` and `tag`:

```json
{
  "data": {
    "items": [
      {
        "id": "t1",
        "category_id": "c1",
        "tag": "urgent",
        "title": "Review release notes"
      }
    ],
    "paging": {
      "current": 1,
      "total": 1
    },
    "cursor": {
      "current": "t1",
      "next": "",
      "prev": ""
    }
  }
}
```

This keeps HTTP responses, client-side cache keys, and realtime refs consistent. A handler may return additional fields, but it MUST NOT omit or change path parameter fields on returned resource items.

The public `@livequery/core` helper type for collection payloads is intentionally small:

```ts
type CollectionResponse<T> = {
  items: T[]
  cursor: {
    current: string
    next: string
    prev: string
  }
  paging: {
    current: number
    total: number
  }
}
```

Field meanings:

| Field | Meaning |
| --- | --- |
| `items` | The returned collection items for the current request. |
| `paging.current` | Current page number or datasource-defined current page position. |
| `paging.total` | Total pages or datasource-defined total page count. |
| `cursor.current` | Cursor representing the current page/window. |
| `cursor.next` | Cursor for the next page/window, or an empty string when unavailable. |
| `cursor.prev` | Cursor for the previous page/window, or an empty string when unavailable. |

Datasource adapters may return a richer payload inside `data` when their clients understand it. For example, a MongoDB-backed datasource may include `summary`, `subscription_token`, `count`, `has`, or `cursor.first`/`cursor.last`. Those fields are datasource conventions, not required by `@livequery/core`.

Document payload:

```ts
type DocumentResponse<T> = {
  item: T
}
```

Wrapped collection response:

```json
{
  "data": {
    "items": [
      { "id": "p1", "title": "Hello" }
    ],
    "paging": {
      "current": 1,
      "total": 1
    },
    "cursor": {
      "current": "p1",
      "next": "",
      "prev": ""
    }
  }
}
```

Wrapped document response:

```json
{
  "data": {
    "item": {
      "id": "p1",
      "title": "Hello"
    }
  }
}
```

Wrapped custom action response:

```json
{
  "data": {
    "published": true,
    "id": "p1"
  }
}
```

## Query Parameters And Filters

Livequery query parameters are flat key/value pairs. `@livequery/core` preserves the parsed query object but does not interpret filters, pagination, sorting, search, or summary expressions.

The filter dialect below is a recommended datasource convention, not a core runtime requirement. Datasources may support a documented subset or superset. MongoDB-backed datasources and browser client runtime matchers should use this dialect when they want interoperable query behavior.

Recommended reserved pagination and search keys:

| Key | Meaning |
| --- | --- |
| `:limit` | Maximum number of items to return. |
| `:before` | Cursor for loading the previous page. |
| `:after` | Cursor for loading the next page. |
| `:around` | Cursor for loading around an item. |
| `:page` | Page number when a datasource supports page-based navigation. |
| `:search` | Datasource-specific full-text search term. |

Field filter keys use this form:

```txt
<field-path>:<operator>
```

When no operator is present, strict equality is used.

Recommended operators:

| Operator | Example | Meaning |
| --- | --- | --- |
| none | `status=active` | Strict equality. |
| `sort` | `createdAt:sort=desc` | Sort key, `asc` or `desc`. |
| `gt`, `gte`, `lt`, `lte` | `score:gte=10` | Numeric comparison. |
| `eq-number`, `neq-number` | `age:eq-number=30` | Numeric equality or inequality after number coercion. |
| `in`, `nin` | `status:in=["active","pending"]` | Membership or non-membership. Values may be arrays or JSON array strings. |
| `ne` | `status:ne=archived` | Strict inequality. |
| `eq-boolean`, `neq-boolean` | `published:eq-boolean=true` | Boolean equality or inequality. |
| `eq-null`, `neq-null` | `deletedAt:eq-null=true` | Null equality or inequality. |
| `eq-oid`, `neq-oid` | `ownerId:eq-oid=...` | ObjectId string equality or inequality for MongoDB-backed datasources. |
| `like` | `title:like=livequery` | Pattern match. MongoDB datasources use regular expressions. |

Nested field paths use dot notation:

```txt
author.id:eq-oid=507f191e810c19729de860ea
stats.views:gte=100
createdAt:sort=desc
```

Summary fields use `::` keys and are datasource-specific. MongoDB-backed datasources may support summary expressions such as `count()`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`, and grouping suffixes.

## Fake Or Non-Database Responses

A Livequery handler does not need a database. It only needs to read `ctx.livequery` and return the standard envelope.

Example:

```ts
import type { LivequeryContext, LivequeryHandler } from '@livequery/core'

type Post = { id: string; title: string }

const posts: Post[] = [
  { id: 'p1', title: 'Hello' },
  { id: 'p2', title: 'World' },
]

class FakePostsHandler implements LivequeryHandler {
  handle(ctx: LivequeryContext) {
    const lq = ctx.livequery
    if (!lq) return

    if (lq.method === 'GET' && lq.collection_ref === 'posts' && !lq.document_id) {
      ctx.response = {
        data: {
          items: posts,
          paging: { current: 1, total: 1 },
          cursor: { current: posts[0]?.id ?? '', next: '', prev: '' },
        },
      }
      return ctx.response
    }

    if (lq.method === 'GET' && lq.collection_ref === 'posts' && lq.document_id) {
      const item = posts.find(post => post.id === lq.document_id)
      ctx.response = item
        ? { data: { item } }
        : { error: { message: 'Post not found', code: 'DOCUMENT_NOT_FOUND' } }
      return ctx.response
    }

    ctx.response = {
      error: {
        message: 'Unsupported request',
        code: 'UNSUPPORTED_REQUEST',
      },
    }
    return ctx.response
  }
}
```

## Realtime Updates

Realtime updates are emitted to a specific collection ref by calling `WebsocketGateway.next(update)`.

Shape:

```ts
ws.next({
  ref: '<collection_ref>',
  type: '<added|modified|removed>',
  data: {
    id: '<document_id>',
    ...fields,
  },
})
```

Create example:

```ts
ws.next({
  ref: 'posts',
  type: 'added',
  data: {
    id: 'p1',
    title: 'Hello',
  },
})
```

Update example:

```ts
ws.next({
  ref: 'posts',
  type: 'modified',
  data: {
    id: 'p1',
    title: 'New title',
  },
})
```

Delete example:

```ts
ws.next({
  ref: 'posts',
  type: 'removed',
  data: {
    id: 'p1',
  },
})
```

Nested collection example:

```ts
ws.next({
  ref: 'users/u1/posts',
  type: 'added',
  data: {
    id: 'p9',
    title: 'Nested post',
  },
})
```

Rules:

- `ref` should be the collection ref containing the changed document.
- `data.id` identifies the changed document.
- `type` is `added` for created documents, `modified` for partial updates, and `removed` for deleted documents.
- A collection update for `posts` with `data.id = 'p1'` notifies subscribers of `posts` and `posts/p1`.
- A nested collection update for `users/u1/posts` with `data.id = 'p9'` notifies subscribers of `users/u1/posts` and `users/u1/posts/p9`.

### Realtime WebSocket Protocol

The default WebSocket path is `/livequery/realtime-updates`, unless configured by the runtime environment.

Client and gateway sockets start with a `start` event:

```json
{
  "event": "start",
  "data": {
    "id": "client-or-gateway-id",
    "auth": ""
  }
}
```

Rules:

- A normal client sends an empty `auth` string.
- A gateway-to-gateway connection sends the target gateway auth token.
- Duplicate socket ids are closed.
- A gateway accepts another gateway socket only when `auth` matches its gateway auth token.

After a successful start, the server replies:

```json
{
  "event": "hello",
  "gid": "gateway-id",
  "binary": true
}
```

HTTP handlers register subscriptions through request headers:

| Header | Meaning |
| --- | --- |
| `x-lcid` | Livequery client id. |
| `socket_id` | Legacy client id alias. |
| `x-lgid` | Gateway id that owns the client socket. Defaults to the local gateway id when omitted by the gateway. |

When `WebsocketGateway.handle(ctx)` receives a parsed Livequery context and a client id header, it subscribes that client to `ctx.livequery.ref`.

Gateway subscription event:

```ts
type RealtimeSubscription = {
  event: 'subscribe'
  ref: string
  client_id: string
  gateway_id: string
  listener_node_id: string
}
```

Unsubscribe event:

```ts
type UnsubscribeEvent = {
  event: 'unsubscribe'
  data: {
    ref?: string
    refs?: string[]
    client_id: string
  }
}
```

Sync event sent to clients:

```ts
type SyncEvent = {
  event: 'sync'
  cids?: string[]
  data?: {
    changes: Array<{
      ref: string
      type: 'added' | 'modified' | 'removed'
      data: { id: string; [key: string]: any }
    }>
  }
}
```

Rules:

- Clients receive `sync` events for refs they subscribed to through HTTP request handling.
- Gateways may forward `subscribe`, `unsubscribe`, and `sync` events between each other.
- When a gateway sends a `sync` event to another gateway, `cids` identifies the downstream client ids that should receive it.
- `link(ref, handler)` creates or replaces an update stream only when the ref already has at least one subscription.
- Disconnecting a client removes that client's subscriptions.
- Disconnecting a gateway removes subscriptions routed through that gateway.

## API Gateway

Livequery can run services behind a gateway. The gateway routes **by path prefix**, from a routing
tree declared up front. There is no runtime discovery: nothing is broadcast, nothing is registered,
and the gateway learns no routes while running.

### Routing Tree

```json
{
  "services": {
    "tasks": { "binding": "TASKS_SERVICE", "url": "http://tasks:8081" }
  },
  "routes": {
    "livequery": {
      "tasks": { "$service": "tasks" },
      "customers": { ":customer_id": { "orders": { "$service": "orders" } } }
    }
  }
}
```

Rules:

- A key prefixed with `$` is metadata; every other key is one path segment.
- A `:name` key matches any single segment.
- `$service` and `$auth` are inherited by everything below them.
- The **deepest** `$service` wins.
- A service target carries both `binding` (a Cloudflare Service Binding) and `url`. Each runtime
  uses whichever it has.
- A service owns every path under its prefix, so adding a route inside a service needs no gateway
  deploy. Only adding a service does, because that needs a new binding.

Because the gateway does not know a service's individual routes, `404` and `405` are produced by
the service, not by the gateway. A path that no service owns is not the gateway's to answer: it
falls through to the next handler.

### Gateway Forwarding

- The gateway forwards the original pathname and query string to the matched service.
- When realtime is enabled and a client id is present, the gateway forwards `x-lcid` and `x-lgid`
  so subscriptions can be attributed to the right socket and gateway.
- Realtime is best effort. If the subscribe or publish step fails, the service has already done the
  work, so the response is still returned.

### Realtime Over Response Headers

A service does not hold client sockets and does not know where they are. It reports what realtime
should do through two response headers, which the gateway acts on and then **strips** before
answering the client:

| Header | Set after | Gateway action |
| --- | --- | --- |
| `x-livequery-ref` | an authorized read | Subscribe the calling client to that ref. |
| `x-livequery-change` | a write | Publish the change to everyone subscribed to that ref. |

This is what keeps a subscription impossible to forge: it is created server-side, only as the
result of a read the caller was already allowed to perform. A `subscribe` frame sent by a client is
ignored unless the gateway is explicitly configured to accept one.

A service with a real change feed — a MongoDB change stream, Postgres `LISTEN/NOTIFY` — skips the
header mechanism and pushes straight into its in-process realtime gateway, which also covers writes
that never went through the API. A datasource without one (D1) emits realtime only from writes that
did go through the API.

## Private Field Sanitization

The helper `hidePrivateFields` can sanitize response payloads before wrapping or returning them:

- Fields beginning with `_` are removed.
- `_id` is mapped to `id` when `id` is missing.
- Plain item, collection payload, and document payload shapes are supported.

When using the standard response envelope, sanitize the payload inside `data`.
