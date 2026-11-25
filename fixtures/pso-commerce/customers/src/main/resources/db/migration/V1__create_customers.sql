CREATE TABLE customers (
    id         VARCHAR(36)  PRIMARY KEY,
    name       VARCHAR(120) NOT NULL,
    email      VARCHAR(254) NOT NULL,
    status     VARCHAR(16)  NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_email_unique ON customers (lower(email));
