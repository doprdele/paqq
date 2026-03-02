#!/bin/sh
set -eu

API_BASE_URL="${PACKT_API_BASE_URL:-}"
ESCAPED_API_BASE_URL=$(printf '%s' "$API_BASE_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__PACKT_CONFIG__ = {
  API_BASE_URL: "${ESCAPED_API_BASE_URL}"
};
EOF
