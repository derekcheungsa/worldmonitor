// Regression guard for commit bde679fbc — the redis-rest proxy's
// `maxHeaderSize` was raised from Node's 16KB default to 8MB so path-based
// SETs from the app's setCachedJson() don't fail with HTTP 431. Without
// this guard, someone "tidying up" the createServer() call could silently
// drop the option and break every cache write whose key+value+TTL
// combined URL exceeds 16KB.
//
// This is a deliberately tiny test: one assertion, no setup. If it ever
// fires, the fix is one line, and the failure message points at exactly
// that line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const proxySrc = readFileSync(resolve(root, 'docker/redis-rest-proxy.mjs'), 'utf8');

describe('redis-rest proxy — maxHeaderSize (commit bde679fbc)', () => {
  it('passes an 8MB maxHeaderSize to http.createServer', () => {
    // Match the exact form: `createServer({ maxHeaderSize: 8 * 1024 * 1024 }, ...)`
    // Allow whitespace between tokens, but pin the value so a future
    // refactor that drops it (or drops to 16KB default) fails loud.
    assert.match(
      proxySrc,
      /http\.createServer\(\s*\{\s*maxHeaderSize:\s*8\s*\*\s*1024\s*\*\s*1024\s*\}/,
      'docker/redis-rest-proxy.mjs must set maxHeaderSize: 8 * 1024 * 1024 on http.createServer — ' +
      'dropping it (or reducing it) re-introduces HTTP 431 on path-based setCachedJson() writes',
    );
  });

  it('keeps the comment explaining WHY (so the next reader does not "clean it up")', () => {
    // Pin the rationale comment too. Without it, the option looks like
    // cargo-culted config and is the obvious candidate for removal in a
    // cleanup PR. The comment names the failure mode and the triggering
    // call site (setCachedJson), so a future reader can grep one or the
    // other before deleting the line.
    assert.match(
      proxySrc,
      /\/\/\s*maxHeaderSize covers the request line too:\s*the app's setCachedJson\(\) sends/i,
      'comment explaining maxHeaderSize rationale must stay in docker/redis-rest-proxy.mjs',
    );
  });
});
