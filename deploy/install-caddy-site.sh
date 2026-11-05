#!/usr/bin/env bash
# Adds the Niinas Wash site to the Caddy that already runs on this server, then reloads it.
# Run from the repository folder as root, after .env is filled in and the API is up:  ./deploy/install-caddy-site.sh
# It checks the whole Caddy config first and puts everything back if the check fails, so the other sites are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."

CADDY_CONTAINER="${CADDY_CONTAINER:-rigel-medsgh-caddy}"
SITES_DIR="${SITES_DIR:-/home/medsgh/rigel-medsgh/caddy/sites}"
TARGET="$SITES_DIR/niinas.caddy"

set -a; . ./.env; set +a
: "${API_DOMAIN:?Set API_DOMAIN in .env}"
: "${ORIGIN_SECRET:?Set ORIGIN_SECRET in .env}"

BACKUP=""
if [ -f "$TARGET" ]; then BACKUP="$(mktemp)"; cp "$TARGET" "$BACKUP"; fi

# API_DOMAIN may list several hostnames separated by commas (useful while moving to a new one); Caddy wants ", ".
HOSTS="$(printf '%s' "$API_DOMAIN" | sed 's/, */, /g')"

sed -e "s|__API_DOMAIN__|$HOSTS|" -e "s|__ORIGIN_SECRET__|$ORIGIN_SECRET|" deploy/niinas.caddy.template > "$TARGET"
chmod 600 "$TARGET"

if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile; then
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
  echo "Installed $TARGET and reloaded $CADDY_CONTAINER."
else
  echo "The Caddy config did not validate. Putting things back; nothing was reloaded." >&2
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$TARGET"; else rm -f "$TARGET"; fi
  exit 1
fi
