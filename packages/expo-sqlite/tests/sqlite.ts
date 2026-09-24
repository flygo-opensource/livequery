import { Database } from 'bun:sqlite'
import type { SQLiteDatabaseLike } from '../src/index.js'

/** expo-sqlite's async API on top of bun:sqlite, for tests. `path` defaults to in-memory. */
export function openTestDatabase(path = ':memory:') {
    const db = new Database(path)
    const wrap = (): SQLiteDatabaseLike & { raw: Database } => ({
        raw: db,
        execAsync: async source => { db.exec(source) },
        runAsync: async (source, ...params) => db.query(source).run(...params),
        getAllAsync: async <T>(source: string, ...params: any[]) => db.query(source).all(...params) as T[],
        getFirstAsync: async <T>(source: string, ...params: any[]) => (db.query(source).get(...params) as T | null) ?? null,
        withExclusiveTransactionAsync: async task => {
            db.exec('BEGIN EXCLUSIVE')
            try {
                await task(wrap())
                db.exec('COMMIT')
            } catch (e) {
                db.exec('ROLLBACK')
                throw e
            }
        },
        closeAsync: async () => db.close(),
    })
    return wrap()
}
