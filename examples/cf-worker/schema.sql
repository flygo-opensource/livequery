CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT    PRIMARY KEY,
    owner      TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'todo',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Every authorized read is scoped by owner, so this is the index that matters.
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks (owner, created_at DESC);
