-- The business tables. V1 (pso_outbox) was added by `pso dispatch:outbox`.
CREATE TABLE orders (
    id          VARCHAR(64)  PRIMARY KEY,
    total_cents BIGINT       NOT NULL CHECK (total_cents > 0),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One shipment per order: the primary key is what makes the consumer idempotent.
CREATE TABLE shipments (
    order_id   VARCHAR(64) PRIMARY KEY REFERENCES orders (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
