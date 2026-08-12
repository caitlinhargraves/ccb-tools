-- ============================================================
-- CCB Tools -- Postgres schema (replaces Monday.com as the
-- data store). Mirrors every board the app currently reads
-- and writes, field for field, so the migration script and
-- the eventual server rewrite have a 1:1 mapping to work from.
-- ============================================================

CREATE TABLE reps (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,          -- original Monday item id, kept for traceability during migration
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Sales Rep',   -- 'Sales Rep' | 'Admin'
  password_hash TEXT,
  sales_person TEXT,                   -- must match the `sales_person` value used on orders/quotes
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  name TEXT NOT NULL,                  -- client / company name
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  ship_to TEXT,
  addr_street TEXT,
  addr_city TEXT,
  addr_state TEXT,
  addr_zip TEXT,
  payment_method TEXT,
  order_status TEXT,
  invoice_status TEXT,
  sales_person TEXT,
  imprint_or_insight TEXT,
  in_hands_date DATE,
  order_submitted_date DATE,
  invoice_sent_date DATE,
  date_paid DATE,
  revenue NUMERIC(12,2) DEFAULT 0,
  gross_profit NUMERIC(12,2) DEFAULT 0,
  commission NUMERIC(12,2) DEFAULT 0,
  commission_rate NUMERIC(5,4) DEFAULT 0,
  ccb_order_number TEXT,
  other_charges NUMERIC(12,2) DEFAULT 0,
  other_charges_details TEXT,
  notes TEXT,
  is_legacy BOOLEAN NOT NULL DEFAULT false,
  legacy_cost_edited BOOLEAN NOT NULL DEFAULT false,
  legacy_total_cost NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_sales_person ON orders(sales_person);
CREATE INDEX idx_orders_name ON orders(lower(name));

CREATE TABLE order_products (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name TEXT,
  style_sku TEXT,
  product_type TEXT,                   -- e.g. "In House Decoration", "3rd Party"
  product_status TEXT,                 -- In House / Pending Approval / Decorated / etc.
  supplier TEXT,
  color TEXT,
  size TEXT,
  quantity NUMERIC(10,2),
  price_per_item NUMERIC(12,2),
  cost_per_item NUMERIC(12,2),
  po_number TEXT,
  po_date DATE,
  production_notes TEXT,
  mockup_urls JSONB DEFAULT '[]',
  -- decoration slots 1-3
  deco_1_type TEXT, deco_1_dept TEXT, deco_1_placement TEXT, deco_1_colors TEXT, deco_1_desc TEXT, deco_1_screens NUMERIC, deco_1_art_urls JSONB DEFAULT '[]', deco_1_notes TEXT,
  deco_2_type TEXT, deco_2_dept TEXT, deco_2_placement TEXT, deco_2_colors TEXT, deco_2_desc TEXT, deco_2_screens NUMERIC, deco_2_art_urls JSONB DEFAULT '[]', deco_2_notes TEXT,
  deco_3_type TEXT, deco_3_dept TEXT, deco_3_placement TEXT, deco_3_colors TEXT, deco_3_desc TEXT, deco_3_screens NUMERIC, deco_3_art_urls JSONB DEFAULT '[]', deco_3_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_products_order_id ON order_products(order_id);
CREATE INDEX idx_order_products_status ON order_products(product_status);

CREATE TABLE quotes (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  client_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  sales_person TEXT,
  quote_type TEXT,                     -- Garment/Decoration | Custom Box
  order_type TEXT,                     -- New Order | Reorder
  status TEXT NOT NULL DEFAULT 'Draft',-- Draft | Sent to Client | Won - Promoted | Lost
  client_order_number INTEGER,
  rolling_12mo_revenue_at_quote NUMERIC(12,2),
  commission_rate NUMERIC(5,4),
  total_revenue NUMERIC(12,2),
  total_cost NUMERIC(12,2),
  gross_profit NUMERIC(12,2),
  commission_amount NUMERIC(12,2),
  gross_margin_pct NUMERIC(6,3),
  quote_date DATE,
  notes TEXT,
  promoted_order_id INTEGER REFERENCES orders(id),
  promoted_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quotes_sales_person ON quotes(sales_person);
CREATE INDEX idx_quotes_status ON quotes(status);

CREATE TABLE quote_line_items (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  name TEXT,
  style_sku TEXT,
  quantity NUMERIC(10,2),
  sell_price_per_unit NUMERIC(12,2),
  garment_cost_per_unit NUMERIC(12,2),      -- also used as "setup cost/unit" for Custom Box lines
  screens_regular NUMERIC,
  screens_large NUMERIC,
  rush_fee NUMERIC(12,2),
  art_hours NUMERIC(6,2),
  deco_cost_per_unit NUMERIC(12,2),
  min_price_floor NUMERIC(12,2),
  line_total_revenue NUMERIC(12,2),
  line_total_cost NUMERIC(12,2),
  line_gross_profit NUMERIC(12,2),
  artwork_description TEXT,
  notes TEXT,
  -- pricing decoration slots (for cost lookup) + production routing slots (department/placement)
  deco_1_type TEXT, deco_1_color_size TEXT, deco_1_dept TEXT, deco_1_placement TEXT, deco_1_desc TEXT, deco_1_screen_count NUMERIC, deco_1_art_url TEXT,
  deco_2_type TEXT, deco_2_color_size TEXT, deco_2_dept TEXT, deco_2_placement TEXT, deco_2_desc TEXT, deco_2_screen_count NUMERIC, deco_2_art_url TEXT,
  deco_3_type TEXT, deco_3_color_size TEXT, deco_3_dept TEXT, deco_3_placement TEXT, deco_3_desc TEXT, deco_3_screen_count NUMERIC, deco_3_art_url TEXT,
  mockup_urls JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quote_line_items_quote_id ON quote_line_items(quote_id);

CREATE TABLE client_notes (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  client_name TEXT NOT NULL,
  sales_person TEXT,
  note TEXT NOT NULL,
  note_date DATE NOT NULL DEFAULT CURRENT_DATE,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_notes_client ON client_notes(lower(client_name));

CREATE TABLE production_time_logs (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  job_name TEXT,
  order_product_id INTEGER REFERENCES order_products(id),
  order_name TEXT,
  worker TEXT NOT NULL,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'Active',   -- Active | Paused | Completed
  start_time TIMESTAMPTZ,
  last_resume_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  accumulated_seconds NUMERIC NOT NULL DEFAULT 0,
  active_duration_seconds NUMERIC
);
CREATE INDEX idx_time_logs_order_product ON production_time_logs(order_product_id);
CREATE INDEX idx_time_logs_worker ON production_time_logs(worker);

CREATE TABLE damaged_goods (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  job_name TEXT,
  order_product_id INTEGER REFERENCES order_products(id),
  order_name TEXT,
  worker TEXT,
  department TEXT,
  quantity NUMERIC(10,2),
  cost_impact NUMERIC(12,2),
  reason TEXT,
  photo_url TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_damaged_goods_worker ON damaged_goods(worker);

CREATE TABLE rep_tasks (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  task_group_id TEXT,                  -- ties together the N per-rep copies of "the same" task
  name TEXT NOT NULL,
  sales_person TEXT NOT NULL,
  description TEXT,
  started_date DATE NOT NULL DEFAULT CURRENT_DATE,
  progress TEXT NOT NULL DEFAULT 'Not Started',
  progress_notes TEXT,
  definition_of_done TEXT,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_date DATE
);
CREATE INDEX idx_rep_tasks_sales_person ON rep_tasks(sales_person);

CREATE TABLE inventory (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  name TEXT,
  raw_columns JSONB     -- catch-all during migration; normalize into real columns once the inventory feature is rebuilt
);

CREATE TABLE gift_boxes (
  id SERIAL PRIMARY KEY,
  monday_item_id TEXT UNIQUE,
  name TEXT,
  raw_columns JSONB
);

-- Every table above keeps monday_item_id purely for migration traceability
-- (so a row can be cross-checked against the original Monday item). It is
-- not meant to be a long-term foreign key to a system we're leaving.
