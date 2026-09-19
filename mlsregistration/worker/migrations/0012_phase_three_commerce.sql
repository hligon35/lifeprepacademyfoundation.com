-- Phase Three commerce foundation.
-- Additive only: preserves the legacy registration/payment tables while adding
-- program-scoped merchandise, Square checkout metadata, fulfillment, and
-- idempotent webhook tracking.

ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN image_url TEXT;
ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'merchandise';
ALTER TABLE products ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

ALTER TABLE orders ADD COLUMN customer_name TEXT;
ALTER TABLE orders ADD COLUMN customer_email TEXT;
ALTER TABLE orders ADD COLUMN square_order_id TEXT;
ALTER TABLE orders ADD COLUMN square_payment_link_id TEXT;
ALTER TABLE orders ADD COLUMN checkout_url TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
ALTER TABLE orders ADD COLUMN paid_at TEXT;
ALTER TABLE orders ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE payments ADD COLUMN square_payment_id TEXT;

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  name TEXT NOT NULL,
  sku TEXT,
  price_cents INTEGER NOT NULL,
  inventory_count INTEGER NOT NULL DEFAULT -1,
  reserved_count INTEGER NOT NULL DEFAULT 0,
  square_catalog_object_id TEXT,
  square_checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON product_variants (product_id, status);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  image_url TEXT NOT NULL,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_images_product
  ON product_images (product_id, sort_order);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  variant_id TEXT REFERENCES product_variants (id),
  product_name TEXT NOT NULL,
  variant_name TEXT,
  sku TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items (order_id);

CREATE TABLE IF NOT EXISTS commerce_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed')),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_square_payment
  ON payments (square_payment_id);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_provider
  ON commerce_webhook_events (provider, external_event_id);

CREATE TABLE IF NOT EXISTS commerce_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  square_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_program_visibility
  ON products (program_id, status, visible, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_program_status
  ON orders (program_id, status, fulfillment_status, created_at);
