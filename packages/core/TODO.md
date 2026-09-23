# TODO — `@livequery/core`

The repo-wide list is in [`../../todo.md`](../../todo.md); this file holds only what lives in this
package.

## Open

- **The buffer of missed changes lives in memory.** Changes for a client inside its grace window
  are kept and sent on reconnect (`_missed`), but a gateway restart — or an evicted Durable Object —
  loses them; the client's reconnect read covers it.
- **`unsubscribe` races the detach.** The ref map is cleared before remote nodes acknowledge, so a
  client that reconnects immediately can end up subscribed twice.
- **No rate limit on WebSocket subscriptions.** Subscription count per socket is unbounded.

## Tests worth adding

- Rapid subscribe/unsubscribe cycling does not leave a duplicate subscription.
- `hidePrivateFields` on nested objects: the shallow copy must not leak mutated state.
