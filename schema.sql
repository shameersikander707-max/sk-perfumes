CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  customer_city TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'Cash on Delivery',
  items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
