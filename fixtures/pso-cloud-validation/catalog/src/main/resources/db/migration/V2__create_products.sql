CREATE TABLE products (
    id          UUID PRIMARY KEY,
    sku         VARCHAR(32)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    price_cents BIGINT       NOT NULL CHECK (price_cents > 0),
    stock       INTEGER      NOT NULL CHECK (stock >= 0),
    CONSTRAINT uq_products_sku UNIQUE (sku)
);

-- One row per order the catalog has decided on. The primary key is what makes the consumer idempotent: a second delivery of
-- the same event finds the row and does nothing.
CREATE TABLE reservations (
    order_id   VARCHAR(64) PRIMARY KEY,
    product_id UUID        NOT NULL REFERENCES products (id),
    quantity   INTEGER     NOT NULL,
    status     VARCHAR(16) NOT NULL CHECK (status IN ('RESERVED', 'REJECTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
