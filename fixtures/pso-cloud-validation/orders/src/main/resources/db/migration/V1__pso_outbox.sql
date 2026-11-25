-- PSO Dispatch transactional outbox. Migrations are immutable once applied: add a new version instead of editing this one.
CREATE TABLE IF NOT EXISTS pso_outbox (
    id              VARCHAR(128) PRIMARY KEY,
    channel         VARCHAR(100)  NOT NULL,
    event_key       VARCHAR(256),
    envelope        TEXT          NOT NULL,
    created_at      TIMESTAMP     NOT NULL,
    attempts        INTEGER       NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP     NOT NULL,
    last_error      VARCHAR(200),
    published_at    TIMESTAMP,
    failed_at       TIMESTAMP
);
CREATE INDEX IF NOT EXISTS pso_outbox_pending ON pso_outbox (next_attempt_at) WHERE published_at IS NULL AND failed_at IS NULL;
