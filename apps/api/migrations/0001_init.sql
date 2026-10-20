-- Karto v1 schema. Append-only: never edit once applied, add 0002_* instead.
-- Timestamps are epoch milliseconds. JSON columns are validated with zod on read.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE baskets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  store_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('parsing', 'searching', 'matching', 'ready', 'pushing', 'pushed', 'failed')),
  inputs TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX baskets_user_created ON baskets (user_id, created_at DESC);

CREATE TABLE basket_items (
  id TEXT PRIMARY KEY,
  basket_id TEXT NOT NULL REFERENCES baskets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  ingredient_key TEXT NOT NULL,
  label TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('g', 'ml', 'piece')),
  sources TEXT NOT NULL DEFAULT '[]',
  search_query TEXT NOT NULL,
  exclude_terms TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending', 'proposed', 'unmatched', 'removed')),
  product_ref TEXT,
  packs INTEGER,
  candidates TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  reason_source TEXT CHECK (reason_source IS NULL OR reason_source IN ('memory', 'rules', 'llm', 'user'))
);
CREATE INDEX basket_items_basket ON basket_items (basket_id, position);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  basket_id TEXT REFERENCES baskets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('provider.search', 'provider.cart_sync', 'llm')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed', 'cancelled')),
  payload TEXT NOT NULL,
  progress TEXT,
  result TEXT,
  error TEXT,
  usage TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_until INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs (status, kind, created_at);
CREATE INDEX jobs_basket ON jobs (basket_id, created_at DESC);
-- At most one active push per user.
CREATE UNIQUE INDEX jobs_one_active_cart_sync ON jobs (user_id)
  WHERE kind = 'provider.cart_sync' AND status IN ('pending', 'running', 'paused');
