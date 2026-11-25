CREATE TABLE customers (
    id         UUID PRIMARY KEY,
    email      VARCHAR(160) NOT NULL,
    name       VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_customers_email UNIQUE (email)
);
