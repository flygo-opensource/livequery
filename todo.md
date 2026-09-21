# TODO

## `@livequery/mongodb`: bare `retry()` in `MongodbRealtime.#listenRawChanges` spins the CPU when `collMod` fails

- Date reported: 2026-09-16
- Affects: `packages/mongodb/src/MongodbRealtime.ts` (`#listenRawChanges`, the `retry()` at the end of the pipe). The published `@livequery/mongodb@2.0.153` and the legacy `@livequery/mongodb-mapper@2.0.58` ship the same bare `retry()`.
- Status: **open upstream**. Downstream (24aff) is running a `bun patch` workaround, see below.

### Incident (24aff production)

- 22 of 56 PM2 services, every one that runs the change-stream watcher, sat at 100–140% CPU from boot for 45 days, ~3.7 GB RSS each. Host load average ~39 on 80 cores, `mongod` at 420% CPU, loopback traffic ~11M packets/s.
- Root cause: `#listenRawChanges` runs `db.command({ collMod, changeStreamPreAndPostImages: { enabled: true } })` before `collection.watch()`. The app's Mongo user only had `readWrite`, so the command failed with `Unauthorized` (code 13). The error propagates to `retry()`, which has no delay and no attempt limit, so the pipeline resubscribed immediately and re-issued `collMod` in a tight loop: ~200 commands/s per process, ~6,000 `Unauthorized` lines/s in the `mongod` log.
- Nothing in the app log showed it. The error is swallowed by `retry()`, so the only symptoms were CPU, RSS growth and the Mongo log.
- `collMod` was also unnecessary in this deployment: 31 of 33 collections already had `changeStreamPreAndPostImages` enabled by an admin.

### What to change

1. **Back off on retry.** Mirror what `packages/postgres/src/PostgresRealtime.ts` already does: exponential delay with a cap, driven by options.

   ```ts
   export type MongoRealtimeOptions = {
       enablePreAndPostImages?: boolean
       // Delay before resubscribing after the change stream (or collMod) fails.
       // Grows exponentially per consecutive failure, capped at maxReconnectDelayMs.
       reconnectDelayMs?: number      // default 1000
       maxReconnectDelayMs?: number   // default 30000
   }
   ```

   ```ts
   const base = this.options.reconnectDelayMs ?? 1000
   const cap = this.options.maxReconnectDelayMs ?? 30000
   // ...
   mergeMap(stream => stream),
   retry({ delay: (_error, count) => timer(Math.min(cap, base * 2 ** (count - 1))) })
   ```

2. **Do not let `collMod` kill the watcher.** `collMod` is an optimisation (it makes `fullDocumentBeforeChange` available on deletes). A failure should degrade, not loop:
   - Wrap the `collMod` call in try/catch. On `Unauthorized` (code 13) log once per collection at `warn` level and continue to `watch()`; `old_data` already falls back to `documentKey` when pre-images are missing.
   - Skip `collMod` entirely when `listCollections` reports `changeStreamPreAndPostImages.enabled === true` for that collection. Saves a privileged command on every boot.

3. **Surface the error.** Pass an optional `onError` / logger hook into `MongoRealtimeOptions` (or emit through the existing logger, if there is one) so a retry storm is visible in the service log instead of only in `mongod`.

4. **Document the required privilege.** README for `@livequery/mongodb` should state that `enablePreAndPostImages` (default on) needs the `collMod` action on the target database, and show the minimal custom role:

   ```js
   db.getSiblingDB('admin').createRole({
     role: 'collModOnly',
     privileges: [{ resource: { db: '<db>', collection: '' }, actions: ['collMod'] }],
     roles: []
   })
   db.getSiblingDB('admin').grantRolesToUser('<app-user>', [{ role: 'collModOnly', db: 'admin' }])
   ```

5. **Test.** Add a unit test that feeds a rejecting `db.command` and asserts the subscription retries with a growing delay (use rxjs `TestScheduler`), and one that asserts `watch()` still starts when `collMod` throws `Unauthorized`. `tests/nestjs-datasource-mapper.e2e.test.ts` already notes that `retry()` spins after `mongo.close()`, the same defect from the other side.

6. **`@livequery/mongodb-mapper`.** Same bare `retry()` at the end of `#listenRawChanges` (`retry(), mergeMap($ => $)`). If the package is still published, apply the same backoff; otherwise mark it deprecated in the README and point at `@livequery/mongodb`.

### Downstream workaround currently in use (24aff, 2026-09-16)

- `bun patch` on both packages: `retry()` → `retry({ delay: 5000 })`. Patches live in `24aff/server/patches/` and are applied through `patchedDependencies`.
- Mongo side: created the `collModOnly` role above and granted it to the app user, so `collMod` succeeds and the retry path is not taken.
- Result after restarting the 52 services: `Unauthorized` rate 0, load ~13, the 22 services at 17–20% CPU.
- Once items 1–2 ship in a release, drop the patches in 24aff and bump the dependency.

### How to reproduce

1. Start Mongo with `--auth`, create a user with only `readWrite` on the target db.
2. Boot any service with `ENABLE_MONGO_CHANGE_STREAM=true` (24aff) or any `MongodbRealtime.watch()` call with `enablePreAndPostImages` unset.
3. Observe: process at 100% CPU within seconds; `docker logs <mongo> | grep -c Unauthorized` climbing by thousands per second; `strace -c -p <pid>` dominated by `sendto`/`recvfrom` pairs carrying `collMod`.
