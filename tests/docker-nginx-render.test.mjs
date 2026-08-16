// Integration guard for the self-hosted nginx render path shipped in:
//
//   bde679fbc  fix(docker): repair self-hosted nginx config and redis-rest proxy
//   0ed033e56  feat(docker): bake self-host defaults so template deploys need only secrets
//
// Before bde679fbc the proxy_pass line referenced `${API_UPSTREAM}` — a
// placeholder that entrypoint.sh never expanded, so /api/* requests to the
// self-hosted stack silently 502'd. bde679fbc replaced it with
// `${LOCAL_API_PORT}` and entrypoint.sh (commit 0ed033e) calls
// `envsubst '$LOCAL_API_PORT $LOCAL_API_TOKEN'` to render the file.
//
// This test invokes the SAME envsubst invocation with the SAME template and
// asserts that the rendered config:
//   1. Has no unsubstituted ${LOCAL_API_PORT} left (would 502 again).
//   2. Has a working proxy_pass to 127.0.0.1:<port>.
//   3. Listens on 8080 (Dockerfile EXPOSE / HEALTHCHECK / compose port map).
//   4. Substitutes LOCAL_API_TOKEN into any location that references it.
//
// We use Node's child_process to invoke envsubst (it's in the nginx base
// image, but not necessarily on the test host), with a JS-based fallback
// when the binary is missing — that way the test still runs in CI without
// nginx installed, and still catches the original bug (unsubstituted
// placeholder) by exercising the same code path entrypoint.sh does.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const templatePath = resolve(root, 'docker/nginx.conf.template');
const entrypointPath = resolve(root, 'docker/entrypoint.sh');

const template  = readFileSync(templatePath, 'utf8');
const entrypoint = readFileSync(entrypointPath, 'utf8');

// nginx ignores lines whose first non-whitespace character is '#'. The
// template's own comments document the historical ${API_UPSTREAM} bug, so
// variable scanning must run on the comment-free view or it reads
// documentation as configuration.
function stripNginxComments(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// Run envsubst the same way entrypoint.sh does. Falls back to a JS
// substitution that mirrors envsubst's contract (only the named vars, not
// the whole shell environment) so the test still proves the property in
// environments where the binary isn't on PATH.
function renderEnvsubst(input, env) {
  const bin = spawnSync('envsubst', [`$LOCAL_API_PORT $LOCAL_API_TOKEN`], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (bin.status === 0 && typeof bin.stdout === 'string') return bin.stdout;
  if (bin.error && bin.error.code === 'ENOENT') {
    // JS fallback: replace ONLY the two named envsubst variables. Matches
    // envsubst's behavior for a literal-only substitution spec.
    const port = String(env.LOCAL_API_PORT ?? '');
    const token = String(env.LOCAL_API_TOKEN ?? '');
    return input
      .replace(/\$\{LOCAL_API_PORT\}/g, port)
      .replace(/\$\{LOCAL_API_TOKEN\}/g, token);
  }
  throw new Error(`envsubst failed: ${bin.stderr || bin.error?.message}`);
}

describe('entrypoint.sh — envsubst contract', () => {
  it('names exactly $LOCAL_API_PORT and $LOCAL_API_TOKEN (regression: no ${API_UPSTREAM} placeholder)', () => {
    // The old placeholder was ${API_UPSTREAM}; if someone re-introduces it
    // (or another un-substituted placeholder), the render would still pass
    // (envsubst ignores unknown vars) but the rendered nginx config would
    // 502. The simplest guard: assert entrypoint.sh's envsubst argument
    // list matches the template's referenced vars exactly.
    const argMatch = entrypoint.match(/envsubst\s+'([^']+)'/);
    assert.ok(argMatch, 'entrypoint.sh must call envsubst with an explicit variable list');
    const namedVars = argMatch[1].trim().split(/\s+/).map((v) => v.replace(/^\$/, ''));

    const templateRefs = new Set();
    for (const m of stripNginxComments(template).matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
      templateRefs.add(m[1]);
    }

    for (const v of templateRefs) {
      assert.ok(
        namedVars.includes(v),
        `nginx template references \${${v}} but entrypoint.sh's envsubst spec does not name it — ` +
        `would render as a literal '${v}' placeholder and break the site. ` +
        `Either add "${v}" to the envsubst argument list or rename the template variable.`,
      );
    }

    // Explicit guard against the specific historical bug — checked on the
    // comment-free view, because the template legitimately *documents* the
    // old placeholder in a comment above the fixed proxy_pass line.
    assert.doesNotMatch(stripNginxComments(template), /\$\{API_UPSTREAM\}/, '${API_UPSTREAM} must not appear in a directive — was the unsubstituted placeholder that 502d /api/*');
  });
});

describe('nginx render — produces a working config', () => {
  let rendered;

  before(() => {
    rendered = renderEnvsubst(template, {
      LOCAL_API_PORT: '46123',
      LOCAL_API_TOKEN: 'test-token-not-secret-32bytes',
    });
  });

  it('expands ${LOCAL_API_PORT} to the configured port (no literal placeholder left)', () => {
    // This is the actual bug bde679fbc fixed: the unrendered template had
    // ${API_UPSTREAM}; after the rename to ${LOCAL_API_PORT}, envsubst must
    // actually be called with that name or the rendered config still 502s.
    assert.doesNotMatch(rendered, /\$\{LOCAL_API_PORT\}/);
    assert.match(rendered, /proxy_pass\s+http:\/\/127\.0\.0\.1:46123;/);
  });

  it('does not leave any unsubstituted shell variables in the rendered config', () => {
    // A working nginx.conf cannot contain "${...}" in a directive — that
    // string is not a valid nginx value and the daemon would fail to start.
    // Comments are exempt: they document the variables, they don't use them.
    const leftover = [...stripNginxComments(rendered).matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
    assert.deepEqual(
      leftover,
      [],
      `rendered nginx.conf has unsubstituted variables: ${leftover.join(', ')}. ` +
      `Add them to entrypoint.sh's envsubst argument list.`,
    );
  });

  it('listens on 8080 (matches Dockerfile EXPOSE + HEALTHCHECK + compose port map)', () => {
    // bde679fbc's first change: nginx was listening on 80, but the Dockerfile
    // EXPOSE 8080 / HEALTHCHECK probed 8080, so the container was marked
    // unhealthy even though nginx was up. The render must listen 8080.
    assert.match(rendered, /^\s*listen\s+8080\s*;/m);
  });

  it('rewrites the SPA entry to dashboard.html (matches Vite dashboardHtmlOutputPlugin)', () => {
    // Static file, not envsubst-driven, but worth pinning so a future
    // refactor of the index directive doesn't silently break the SPA.
    assert.match(rendered, /^\s*index\s+dashboard\.html\s*;/m);
  });
});
