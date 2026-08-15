# =============================================================================
# AIS Relay — self-contained Railway deploy image
# =============================================================================
# Builds from a fresh clone of the fork so this directory works as a standalone
# Docker build context (Railway templates can only set rootDirectory, not a
# custom dockerfile path, so each service needs a dir whose default Dockerfile
# is the right one).
# =============================================================================
FROM node:24-alpine

# curl required by OREF polling (Node.js JA3 fingerprint blocked by Akamai)
RUN apk add --no-cache curl git

ARG REPO=https://github.com/derekcheungsa/worldmonitor.git
ARG BRANCH=main
RUN git clone --depth 1 --branch ${BRANCH} ${REPO} /app
WORKDIR /app

# Relay runtime deps (mirrors Dockerfile.relay: no native build scripts needed)
RUN npm ci --prefix scripts --omit=dev --omit=optional --ignore-scripts

# RELAY_PORT pins the listen port (Railway injects PORT=8080 into every service
# at runtime, which would otherwise override the 3004 default the stack wires).
# UPSTASH_* defaults let the seed loops reach the plain-HTTP REST proxy without
# manual env wiring (compose/template users can still override).
ENV RELAY_PORT=3004 \
    UPSTASH_ALLOW_INSECURE_HTTP=true \
    UPSTASH_REDIS_REST_URL=http://redis-rest.railway.internal:80

EXPOSE 3004

CMD ["node", "scripts/ais-relay.cjs"]
