# Livequery Specification

This document defines the framework-agnostic Livequery model used by `@livequery/core`.

Livequery is not a database engine and does not require any specific HTTP framework. A Livequery service can be backed by a database, an external API, an in-memory map, generated data, or any custom handler. The standard is the request model, response envelope, path grammar, action model, and realtime update shape.

## Core Idea

Livequery maps an HTTP path to a normalized data reference called a `ref`.

Examples:

| Request path | Meaning | Ref |
| --- | --- | --- |
| `/livequery/posts` | `posts` collection | `posts` |
| `/livequery/posts/p1` | `posts/p1` document | `posts/p1` |
| `/livequery/users/u1/posts` | nested `posts` collection for user `u1` | `users/u1/posts` |
| `/livequery/users/u1/posts/p1` | nested post document `p1` for user `u1` | `users/u1/posts/p1` |

The `livequery` prefix is a route prefix. It is not part of the normalized data ref.

## Request Model

A framework adapter provides a `RawRequest`, then `LivequeryRequestParser` creates a normalized `LivequeryRequest`.

Important fields:

```ts
type LivequeryRequest<I = any> = {
  keys: Record<string, any>
  path: string
  document_id?: string
  collection_ref: string
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
| `ref` | Concrete data reference for this request, such as `posts` or `posts/p1`. |
| `collection_ref` | Concrete collection containing the item, such as `posts` or `users/u1/posts`. |
| `schema_collection_ref` | Route-pattern collection ref using parameter names instead of values, such as `users/uid/posts`. |
| `document_id` | Document id when the request targets a document. Undefined for collection requests. |
| `keys` | Route parameters supplied by the framework adapter. |
| `method` | Uppercased HTTP method. |
| `body` | Request body. The format is application-defined. |
| `query` | Parsed query parameters. Query values are not part of the path grammar. |

## Collection And Document Paths

Livequery distinguishes collections and documents by the route pattern.

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

- Custom actions must use HTTP `POST`.
- The part before `~` is parsed as the normal Livequery data ref.
- The part after `~` is the custom action verb.
- `~` is only meaningful in the pathname.
- `~` inside a query string is part of the query value and is not a custom action.

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

Current type definitions may not expose every conceptual field yet. When adding custom action support to implementation code, preserve the rules above and add tests for collection actions, document actions, non-POST rejection, and query strings containing `~`.

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

Livequery payloads are free-form. The following shapes are common helpers, not the only allowed payloads.

Collection payload:

```ts
type CollectionResponse<T> = {
  items: T[]
  paging: {
    current: number
    total: number
  }
  cursor: {
    current: string
    next: string
    prev: string
  }
}
```

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
      "current": "",
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
          cursor: { current: '', next: '', prev: '' },
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
  type: '<created|updated|deleted>',
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
  type: 'created',
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
  type: 'updated',
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
  type: 'deleted',
  data: {
    id: 'p1',
  },
})
```

Nested collection example:

```ts
ws.next({
  ref: 'users/u1/posts',
  type: 'created',
  data: {
    id: 'p9',
    title: 'Nested post',
  },
})
```

Rules:

- `ref` should be the collection ref containing the changed document.
- `data.id` identifies the changed document.
- A collection update for `posts` with `data.id = 'p1'` notifies subscribers of `posts` and `posts/p1`.
- A nested collection update for `users/u1/posts` with `data.id = 'p9'` notifies subscribers of `users/u1/posts` and `users/u1/posts/p9`.

## Private Field Sanitization

The helper `hidePrivateFields` can sanitize response payloads before wrapping or returning them:

- Fields beginning with `_` are removed.
- `_id` is mapped to `id` when `id` is missing.
- Plain item, collection payload, and document payload shapes are supported.

When using the standard response envelope, sanitize the payload inside `data`.
