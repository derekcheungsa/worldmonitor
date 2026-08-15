#!/bin/sh
set -e

# Docker secrets → env var bridge
# Reads /run/secrets/KEYNAME files and exports as env vars.
# Secrets take priority over env vars set via docker-compose environment block.
if [ -d /run/secrets ]; then
  for secret_file in /run/secrets/*; do
    [ -f "$secret_file" ] || continue
    key=$(basename "$secret_file")
    value=$(cat "$secret_file" | tr -d '\n')
    export "$key"="$value"
  done
fi

export LOCAL_API_PORT="${LOCAL_API_PORT:-46123}"

# Self-host defaults for Railway-style deployments, where sibling services are
# reachable on the private network as <service>.railway.internal. Every value
# stays overridable via environment; compose/SELF_HOSTING.md users already set
# these explicitly, so the defaults only kick in for bare template deploys.
export UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://redis-rest.railway.internal:80}"
export WS_RELAY_URL="${WS_RELAY_URL:-http://ais-relay.railway.internal:3004}"
export LOCAL_API_MODE="${LOCAL_API_MODE:-docker}"
export LOCAL_API_CLOUD_FALLBACK="${LOCAL_API_CLOUD_FALLBACK:-false}"

if [ -z "${LOCAL_API_TOKEN:-}" ]; then
  LOCAL_API_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  export LOCAL_API_TOKEN
fi

envsubst '$LOCAL_API_PORT $LOCAL_API_TOKEN' < /etc/nginx/nginx.conf.template > /tmp/nginx.conf
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/worldmonitor.conf
