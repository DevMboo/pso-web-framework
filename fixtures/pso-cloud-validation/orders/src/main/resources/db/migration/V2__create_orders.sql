-- V1 (pso_outbox) was added by `pso dispatch:outbox`.
CREATE TABLE orders (
    id          UUID PRIMARY KEY,
    customer_id UUID        NOT NULL,
    product_id  UUID        NOT NULL,
    quantity    INTEGER     NOT NULL CHECK (quantity > 0),
    status      VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
