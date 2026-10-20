-- Memory (step 7): the product a user last pushed for an ingredient. Append-only, like 0001.
-- source: 'replaced' when the user changed the product, else 'validated'. use_count: pushes of this product.

CREATE TABLE choices (
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  ingredient_key TEXT NOT NULL,
  product_ref TEXT NOT NULL,
  product_label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('validated', 'replaced')),
  use_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider, ingredient_key)
);
