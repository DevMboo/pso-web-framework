-- Migrations are append-only: never edit an applied version, add a new one (V2__..., V3__...).
CREATE TABLE products (
    id          UUID PRIMARY KEY,
    sku         VARCHAR(32)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    price_cents BIGINT       NOT NULL CHECK (price_cents > 0),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version     BIGINT       NOT NULL DEFAULT 0,
    CONSTRAINT uq_products_sku UNIQUE (sku)
);
