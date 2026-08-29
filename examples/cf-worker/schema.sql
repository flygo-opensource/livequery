CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'todo',
    created_at INTEGER NOT NULL
);
