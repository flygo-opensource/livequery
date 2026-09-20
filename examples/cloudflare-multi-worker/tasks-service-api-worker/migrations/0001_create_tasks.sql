CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    assignee_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
    ON tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_created_at
    ON tasks (assignee_id, created_at DESC);
