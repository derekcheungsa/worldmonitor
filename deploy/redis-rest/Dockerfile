# =============================================================================
# Redis REST proxy — self-contained Railway deploy image
# =============================================================================
# Builds from a fresh clone of the fork so this directory works as a standalone
# Docker build context (Railway templates can only set rootDirectory, not a
# custom dockerfile path). The proxy source stays canonical at
# docker/redis-rest-proxy.mjs.
# =============================================================================
FROM node:24-alpine

RUN apk add --no-cache git

ARG REPO=https://github.com/derekcheungsa/worldmonitor.git
ARG BRANCH=main
RUN git clone --depth 1 --branch ${BRANCH} ${REPO} /src

WORKDIR /app
RUN cp /src/docker/redis-rest-proxy.mjs . \
    && npm init -y \
    && npm install redis@4 \
    && rm -rf /src

# SRH_PORT pins the listen port: Railway injects PORT=8080 into every service
# at runtime, which would otherwise override the 80 default the stack wires.
# WM_REDIS_TOKEN is the canonical bearer token name shared with the app/relay
# services so a template can generate ONE secret and reference it everywhere.
ENV SRH_PORT=80

EXPOSE 80

CMD ["node", "redis-rest-proxy.mjs"]
