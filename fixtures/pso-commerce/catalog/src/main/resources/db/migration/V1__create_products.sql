CREATE TABLE products (
    id          VARCHAR(36)  PRIMARY KEY,
    sku         VARCHAR(40)  NOT NULL UNIQUE,
    name        VARCHAR(120) NOT NULL,
    price_cents BIGINT       NOT NULL CHECK (price_cents >= 0),
    stock       INTEGER      NOT NULL CHECK (stock >= 0)
);
-- orders whose stock movement was applied: an event delivered twice changes the stock once
CREATE TABLE applied_orders (
    order_id   VARCHAR(36) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
