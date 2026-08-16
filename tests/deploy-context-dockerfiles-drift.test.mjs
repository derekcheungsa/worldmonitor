// Drift guard for the deploy/ Railway-template Dockerfiles shipped in commit
// cde0e20. These Dockerfiles are intended to mirror Dockerfile.relay and
// docker/Dockerfile.redis-rest for the listen-port + env-default contract.
// A future PR that bumps the pinned port in only one of the two places
// would silently break Railway templates: the service would listen on the
// wrong port while compose users keep working.
//
// What this test pins:
//   1. The deploy/ Dockerfiles exist and are non-empty (Railway templates
//      require a per-service rootDirectory with a default Dockerfile).
//   2. They each set the SAME listen port as their canonical counterpart.
//   3. They each EXPOSE the same port as their canonical counterpart.
//   4. They share the canonical CMD (the entry script).
//
// It does NOT pin the full COPY list, because the deploy Dockerfiles build
// from a fresh clone (different mechanism) while the canonical Dockerfiles
// COPY from a staged build context. Pinning the COPY list would be wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const relayCanonical    = readFileSync(resolve(root, 'Dockerfile.relay'), 'utf8');
const proxyCanonical    = readFileSync(resolve(root, 'docker/Dockerfile.redis-rest'), 'utf8');
const relayDeploy       = readFileSync(resolve(root, 'deploy/ais-relay/Dockerfile'), 'utf8');
const proxyDeploy       = readFileSync(resolve(root, 'deploy/redis-rest/Dockerfile'), 'utf8');

function extractEnvVar(src, name) {
  // Dockerfile ENV directives may span multiple lines via backslash
  // continuation (`ENV A=1 \` + `    B=2`). Join continuations first, then
  // parse key=value pairs off the logical ENV line.
  const logical = src.replace(/\\\r?\n/g, ' ');
  for (const line of logical.split(/\r?\n/)) {
    const m = line.match(/^ENV\s+(.+)$/);
    if (!m) continue;
    for (const pair of m[1].trim().split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
    }
  }
  return null;
}

function extractExpose(src) {
  const m = src.match(/^EXPOSE\s+(\d+)\s*$/m);
  return m ? m[1] : null;
}

function extractCmdTail(src) {
  // CMD ["node", "scripts/ais-relay.cjs"] — JSON form. The deploy files
  // use this form; the canonical Dockerfile.relay does too.
  const m = src.match(/CMD\s+\[\s*["']node["'],\s*["']([^"']+)["']\s*\]\s*/);
  return m ? m[1] : null;
}

describe('deploy/ais-relay/Dockerfile — drifts with Dockerfile.relay', () => {
  it('exists', () => {
    assert.ok(relayDeploy.length > 0);
  });

  it('pins the same RELAY_PORT as Dockerfile.relay', () => {
    const canonical = extractEnvVar(relayCanonical, 'RELAY_PORT');
    const deploy    = extractEnvVar(relayDeploy,    'RELAY_PORT');
    assert.ok(canonical, 'Dockerfile.relay must set RELAY_PORT (regression: dropped the pin)');
    assert.ok(deploy,    'deploy/ais-relay/Dockerfile must set RELAY_PORT');
    assert.equal(deploy, canonical, `RELAY_PORT drift: Dockerfile.relay=${canonical} deploy/ais-relay=${deploy}`);
  });

  it('EXPOSE the same port as Dockerfile.relay', () => {
    const canonical = extractExpose(relayCanonical);
    const deploy    = extractExpose(relayDeploy);
    assert.equal(deploy, canonical, `EXPOSE drift: Dockerfile.relay=${canonical} deploy/ais-relay=${deploy}`);
  });

  it('CMD runs the same entrypoint as Dockerfile.relay', () => {
    const canonical = extractCmdTail(relayCanonical);
    const deploy    = extractCmdTail(relayDeploy);
    assert.ok(canonical, 'Dockerfile.relay must use the JSON CMD form');
    assert.ok(deploy);
    assert.equal(deploy, canonical, `CMD drift: Dockerfile.relay=${canonical} deploy/ais-relay=${deploy}`);
  });
});

describe('deploy/redis-rest/Dockerfile — drifts with docker/Dockerfile.redis-rest', () => {
  it('exists', () => {
    assert.ok(proxyDeploy.length > 0);
  });

  it('pins the same SRH_PORT as docker/Dockerfile.redis-rest', () => {
    const canonical = extractEnvVar(proxyCanonical, 'SRH_PORT');
    const deploy    = extractEnvVar(proxyDeploy,    'SRH_PORT');
    assert.ok(canonical, 'docker/Dockerfile.redis-rest must set SRH_PORT');
    assert.ok(deploy,    'deploy/redis-rest/Dockerfile must set SRH_PORT');
    assert.equal(deploy, canonical, `SRH_PORT drift: canonical=${canonical} deploy=${deploy}`);
  });

  it('EXPOSE the same port as docker/Dockerfile.redis-rest', () => {
    const canonical = extractExpose(proxyCanonical);
    const deploy    = extractExpose(proxyDeploy);
    assert.equal(deploy, canonical, `EXPOSE drift: canonical=${canonical} deploy=${deploy}`);
  });

  it('CMD runs the same entrypoint as docker/Dockerfile.redis-rest', () => {
    const canonical = extractCmdTail(proxyCanonical);
    const deploy    = extractCmdTail(proxyDeploy);
    assert.ok(canonical);
    assert.ok(deploy);
    assert.equal(deploy, canonical, `CMD drift: canonical=${canonical} deploy=${deploy}`);
  });
});

describe('deploy/ais-relay/Dockerfile — Upstash defaults stay in sync', () => {
  // Railway template users get these env defaults baked in; compose users
  // override them. If Dockerfile.relay drops UPSTASH_REDIS_REST_URL but
  // deploy/ais-relay/Dockerfile keeps it, the two surfaces diverge and the
  // next refactor will miss one. Pin both.
  const SHARED_ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_ALLOW_INSECURE_HTTP'];

  for (const name of SHARED_ENV) {
    it(`${name} is set in both Dockerfile.relay and deploy/ais-relay/Dockerfile`, () => {
      const canonical = extractEnvVar(relayCanonical, name);
      const deploy    = extractEnvVar(relayDeploy,    name);
      assert.ok(canonical, `Dockerfile.relay must set ${name}`);
      assert.ok(deploy,    `deploy/ais-relay/Dockerfile must set ${name}`);
      assert.equal(deploy, canonical, `${name} drift between Dockerfile.relay and deploy/ais-relay/Dockerfile`);
    });
  }
});
