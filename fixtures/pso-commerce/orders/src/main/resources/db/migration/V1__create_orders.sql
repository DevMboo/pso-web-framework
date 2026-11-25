CREATE TABLE orders (
    id               VARCHAR(36) PRIMARY KEY,
    customer_id      VARCHAR(36) NOT NULL,
    product_id       VARCHAR(36) NOT NULL,
    quantity         INTEGER     NOT NULL CHECK (quantity > 0),
    unit_price_cents BIGINT      NOT NULL CHECK (unit_price_cents >= 0),
    total_cents      BIGINT      NOT NULL CHECK (total_cents >= 0),
    status           VARCHAR(16) NOT NULL CHECK (status IN ('PLACED', 'CONFIRMED', 'CANCELLED')),
    created_by       VARCHAR(128) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer ON orders (customer_id, created_at);
