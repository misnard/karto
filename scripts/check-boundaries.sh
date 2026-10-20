#!/bin/sh
# Enforces CLAUDE.md rules 1 and 2:
#  1. Carrefour-specific code lives only in packages/provider-carrefour (manifest host permissions excepted).
#  2. No checkout / payment / slot / promo / cart-clearing endpoint anywhere in the provider source.
set -eu
cd "$(dirname "$0")/.."

carrefour='carrefour\.fr|/api/cart|/autocomplete|/api/me|facilityServiceId|basketServiceId|subBasketType|drive_clcv'
leaks=$(grep -rnE "$carrefour" apps packages services \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.sql' --include='*.html' 2>/dev/null \
  | grep -v '/node_modules/' | grep -v '/dist/' | grep -v '/\.wrangler/' \
  | grep -v '^packages/provider-carrefour/' \
  | grep -v '^apps/extension/public/manifest.json:' || true)

forbidden='checkout|payment|paiement|payline|/api/cart/slot|attach-slot|timeslots|promo_code|only-unavailable'
payments=$(grep -rniE "$forbidden" packages/provider-carrefour/src 2>/dev/null | grep -v '\.test\.ts:' || true)

status=0
if [ -n "$leaks" ]; then
  echo "Carrefour-specific code outside packages/provider-carrefour:" >&2
  echo "$leaks" >&2
  status=1
fi
if [ -n "$payments" ]; then
  echo "Forbidden endpoint reference in packages/provider-carrefour/src:" >&2
  echo "$payments" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "boundaries OK"
exit "$status"
