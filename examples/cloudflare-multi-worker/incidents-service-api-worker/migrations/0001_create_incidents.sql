CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    elevator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_incidents_elevator_created_at
    ON incidents (elevator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_status_severity_created_at
    ON incidents (status, severity, created_at DESC);
