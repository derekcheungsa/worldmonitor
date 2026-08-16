// Regression guards for the self-host-defaults work shipped in:
//
//   bde679fbc  fix(docker): repair self-hosted nginx config and redis-rest proxy
//   0ed033e56  feat(docker): bake self-host defaults so template deploys need only secrets
//   a76547679  feat(docker): canonical WM_REDIS_TOKEN for the REST proxy
//   cde0e20de  feat(deploy): self-contained Dockerfiles for Railway template services
//
// Each assertion here is a *guard*, not a feature test — if any of these
// regress, a Railway template deploy breaks silently: the relay listens on
// 8080 instead of 3004 (sibling services can't reach it), the proxy listens
// on 8080 instead of 80 (nginx proxy_pass points at a dead port), the proxy
// refuses auth (only SRH_TOKEN is read), or env defaults are silently
// overriding user-provided values. The Dockerfiles/entrypoint.sh tests are
// static: we read the file and assert the literal lines, the same way
// tests/dockerfile-relay-imports.test.mjs reads COPY lines.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Parse a Dockerfile ENV directive that may span multiple lines via
// backslash continuation. Both Dockerfile.relay and the deploy/ Dockerfiles
// write multi-value ENV blocks as `ENV A=1 \` + `    B=2`, which a naive
// single-line `^ENV NAME=value$` regex cannot see. Returns the value for
// `name` or null.
function dockerEnvVar(src, name) {
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

const relaySrc     = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const proxySrc     = readFileSync(resolve(root, 'docker/redis-rest-proxy.mjs'), 'utf8');
const relayDocker  = readFileSync(resolve(root, 'Dockerfile.relay'), 'utf8');
const proxyDocker  = readFileSync(resolve(root, 'docker/Dockerfile.redis-rest'), 'utf8');
const entrypoint   = readFileSync(resolve(root, 'docker/entrypoint.sh'), 'utf8');

describe('relay — RELAY_PORT precedence (commit 0ed033e)', () => {
  // Railway injects PORT=8080 into every service at runtime; the relay must
  // ignore that and bind 3004 unless RELAY_PORT explicitly overrides it.
  // This is the exact failure mode commit 0ed033e shipped to fix.
  it('reads RELAY_PORT before PORT', () => {
    const m = relaySrc.match(/const\s+PORT\s*=\s*process\.env\.([A-Z_]+)\s*\|\|\s*process\.env\.([A-Z_]+)/);
    assert.ok(m, 'ais-relay.cjs must define PORT via a RELAY_PORT || PORT chain');
    assert.equal(m[1], 'RELAY_PORT', 'RELAY_PORT must be checked first so Railway-injected PORT=8080 cannot override');
    assert.equal(m[2], 'PORT');
  });

  it('falls back to 3004 when neither env is set', () => {
    const m = relaySrc.match(/const\s+PORT\s*=\s*process\.env\.RELAY_PORT\s*\|\|\s*process\.env\.PORT\s*\|\|\s*(\d+)/);
    assert.ok(m, 'ais-relay.cjs PORT chain must end with a literal default');
    assert.equal(m[1], '3004', 'default listen port must remain 3004 — docker-compose + Dockerfile.relay + deploy/ais-relay/Dockerfile all wire this port');
  });
});

describe('redis-rest proxy — SRH_PORT / WM_REDIS_TOKEN precedence (commits 0ed033e + a765476)', () => {
  it('reads SRH_PORT before PORT (Railway PORT=8080 override guard)', () => {
    const m = proxySrc.match(/const\s+PORT\s*=\s*parseInt\(process\.env\.([A-Z_]+)\s*\|\|\s*process\.env\.([A-Z_]+)/);
    assert.ok(m, 'proxy PORT must be parsed from a SRH_PORT || PORT chain');
    assert.equal(m[1], 'SRH_PORT');
    assert.equal(m[2], 'PORT');
  });

  it('falls back to port 80 when neither env is set (compose + deploy Dockerfile wire 80)', () => {
    const m = proxySrc.match(/const\s+PORT\s*=\s*parseInt\(process\.env\.SRH_PORT\s*\|\|\s*process\.env\.PORT\s*\|\|\s*'(\d+)',\s*10\)/);
    assert.ok(m, 'proxy PORT chain must end with a literal default');
    assert.equal(m[1], '80');
  });

  it('reads WM_REDIS_TOKEN before SRH_TOKEN (canonical-template secret name)', () => {
    const m = proxySrc.match(/const\s+TOKEN\s*=\s*process\.env\.([A-Z_]+)\s*\|\|\s*process\.env\.([A-Z_]+)/);
    assert.ok(m, 'proxy TOKEN must be read from a WM_REDIS_TOKEN || SRH_TOKEN chain');
    assert.equal(m[1], 'WM_REDIS_TOKEN', 'WM_REDIS_TOKEN is the canonical name shared with the app/relay UPSTASH_REDIS_REST_TOKEN');
    assert.equal(m[2], 'SRH_TOKEN', 'SRH_TOKEN stays as the docker-compose name for back-compat');
  });

  it('listens on 0.0.0.0 (not 127.0.0.1) so Railway private-network siblings can reach it', () => {
    assert.match(proxySrc, /server\.listen\(\s*PORT\s*,\s*['"]0\.0\.0\.0['"]/);
    assert.doesNotMatch(proxySrc, /server\.listen\(\s*PORT\s*,\s*['"]127\.0\.0\.1['"]/);
  });
});

describe('Dockerfile.relay — self-host defaults (commit 0ed033e)', () => {
  it('pins RELAY_PORT=3004 so Railway PORT=8080 cannot move the listen port', () => {
    assert.equal(dockerEnvVar(relayDocker, 'RELAY_PORT'), '3004');
  });

  it('defaults UPSTASH_REDIS_REST_URL to the Railway private-network proxy', () => {
    assert.equal(dockerEnvVar(relayDocker, 'UPSTASH_REDIS_REST_URL'), 'http://redis-rest.railway.internal:80');
  });

  it('enables UPSTASH_ALLOW_INSECURE_HTTP for the plain-HTTP compose proxy', () => {
    assert.equal(dockerEnvVar(relayDocker, 'UPSTASH_ALLOW_INSECURE_HTTP'), 'true');
  });

  it('EXPOSE 3004 matches the pinned RELAY_PORT default', () => {
    assert.match(relayDocker, /^EXPOSE\s+3004\s*$/m);
  });

  it('HEALTHCHECK probes the pinned 3004 port (not Railway-injected PORT=8080)', () => {
    // The commit-message rationale is explicit: "127.0.0.1, not localhost".
    assert.match(relayDocker, /HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:3004\/health/);
    assert.doesNotMatch(relayDocker, /HEALTHCHECK[\s\S]*http:\/\/localhost/);
  });
});

describe('docker/Dockerfile.redis-rest — self-host defaults (commit 0ed033e)', () => {
  it('pins SRH_PORT=80', () => {
    assert.match(proxyDocker, /^ENV\s+SRH_PORT=80\s*$/m);
  });

  it('EXPOSE 80 matches the pinned SRH_PORT default', () => {
    assert.match(proxyDocker, /^EXPOSE\s+80\s*$/m);
  });
});

describe('docker/entrypoint.sh — :- semantics (commit 0ed033e)', () => {
  // entrypoint.sh sets defaults with `${VAR:-default}` so they only kick in
  // when the user did NOT provide a value. If someone refactors to
  // `${VAR-default}`, a user-provided empty string (env: "") would be
  // replaced by the default — a silent behavior change. Guard the pattern.
  //
  // Also: every default must remain env-overridable. A `${VAR:-default}`
  // expression MUST appear; a bare `export VAR=default` would clobber user
  // values and break compose/SELF_HOSTING.md users who set these explicitly.
  const EXPECTED_DEFAULTS = [
    { var: 'LOCAL_API_PORT',          default: '46123' },
    { var: 'UPSTASH_REDIS_REST_URL',   default: 'http://redis-rest.railway.internal:80' },
    { var: 'WS_RELAY_URL',             default: 'http://ais-relay.railway.internal:3004' },
    { var: 'LOCAL_API_MODE',           default: 'docker' },
    { var: 'LOCAL_API_CLOUD_FALLBACK', default: 'false' },
  ];

  for (const { var: varName, default: defVal } of EXPECTED_DEFAULTS) {
    it(`${varName} uses '\${:-}' (empty-or-unset fallback), not '\${-}' (unset-only)`, () => {
      // The exact form we ship: export FOO="${FOO:-default}".
      // Match either quoting style (single/double) the project may use.
      const re = new RegExp(`export\\s+${varName}=\\s*["']?\\$\\{${varName}:-`, 'm');
      assert.match(entrypoint, re, `${varName} must use :- fallback so empty user values are not silently replaced`);
    });

    it(`${varName} defaults to ${defVal}`, () => {
      const re = new RegExp(`\\$\\{${varName}:-${defVal.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\}`, 'm');
      assert.match(entrypoint, re);
    });
  }

  it('LOCAL_API_TOKEN is auto-generated only when unset (preserves user-provided tokens)', () => {
    // Guard against the classic bug of moving the randomBytes call outside
    // the `if [ -z ... ]` block, which would overwrite a user's token on
    // every container start.
    assert.match(entrypoint, /if\s+\[\s+-z\s+"\$\{LOCAL_API_TOKEN:-/);
    assert.match(entrypoint, /randomBytes\(32\)\.toString\(['"]base64url['"]\)/);
  });

  it('envsubst expands both LOCAL_API_PORT and LOCAL_API_TOKEN (nginx template contract)', () => {
    assert.match(entrypoint, /envsubst\s+'\$LOCAL_API_PORT\s+\$LOCAL_API_TOKEN'/);
  });
});

describe('deploy/ — Railway template Dockerfile contexts (commit cde0e20)', () => {
  // Railway templates can only set rootDirectory per service, not a custom
  // dockerfile path. Each deploy/<svc>/ directory is its own Docker build
  // context, and its default Dockerfile must build the right image from a
  // fresh clone of the fork. These guards catch two drift classes:
  //   1. A deploy Dockerfile forgets to pin the listen port (Railway
  //      PORT=8080 would move the service off the port sibling services
  //      expect).
  //   2. A deploy Dockerfile drifts from the canonical Dockerfile.relay /
  //      docker/Dockerfile.redis-rest (e.g. someone bumps the pinned port
  //      in only one of the two places).
  const cases = [
    {
      service: 'ais-relay',
      file: 'deploy/ais-relay/Dockerfile',
      cmdTail: 'scripts/ais-relay.cjs',
      requiredEnv: { RELAY_PORT: '3004' },
      requiredExpose: '3004',
      fromBase: 'node:24-alpine',
    },
    {
      service: 'redis-rest',
      file: 'deploy/redis-rest/Dockerfile',
      cmdTail: 'redis-rest-proxy.mjs',
      requiredEnv: { SRH_PORT: '80' },
      requiredExpose: '80',
      fromBase: 'node:24-alpine',
    },
  ];

  for (const { service, file, cmdTail, requiredEnv, requiredExpose, fromBase } of cases) {
    describe(`${service}/Dockerfile`, () => {
      const abs = resolve(root, file);
      const exists = existsSync(abs);
      const src = exists ? readFileSync(abs, 'utf8') : '';

      it('exists and is non-empty', () => {
        assert.ok(exists, `${file} must exist — Railway templates need a per-service rootDirectory`);
        assert.ok(src.length > 0, `${file} must not be empty`);
      });

      it(`extends ${fromBase} so the runtime matches the canonical Dockerfiles`, () => {
        assert.match(src, new RegExp(`^FROM\\s+${fromBase.replace(/\+/g, '\\+')}`, 'm'));
      });

      for (const [k, v] of Object.entries(requiredEnv)) {
        it(`pins ${k}=${v} so Railway-injected PORT cannot move the listen port`, () => {
          assert.equal(dockerEnvVar(src, k), v);
        });
      }

      it(`EXPOSE ${requiredExpose} matches the pinned port`, () => {
        assert.match(src, new RegExp(`^EXPOSE\\s+${requiredExpose}\\s*$`, 'm'));
      });

      it(`CMD runs ${cmdTail}`, () => {
        assert.match(src, new RegExp(`CMD\\s*\\[?["']node["'],\\s*["']${cmdTail.replace(/\./g, '\\.')}["']\\]?`));
      });

      it('clones the fork so the context is self-contained', () => {
        assert.match(src, /git\s+clone/);
        assert.match(src, /--branch\s+\$\{?BRANCH\}?/);
      });

      it('defaults REPO to derekcheungsa/worldmonitor.git (template-author fork)', () => {
        // If you ever publish this template to a third party, update this
        // guard along with the default; right now the build-arg default
        // doubles as a "this is the canonical template source" pointer.
        assert.match(src, /^ARG\s+REPO=https:\/\/github\.com\/derekcheungsa\/worldmonitor\.git\s*$/m);
      });
    });
  }
});
