/**
 * feishu platform adapter — `verify` action + A-4 hygiene tests.
 * V8.2 (2026-06-19) split: extracted from platform/feishu.test.js (V3 era →
 * V5.2 verify + V7.1 card accumulation) into per-action files. The split
 * is purely organisational (same tests, same fixtures, same helpers);
 * no logic change.
 *
 * Test code 0 改: only file layout + describe names. Refactor, not
 * re-design.
 *
 * Run: `node --test platform/feishu.verify.test.js`
 *
 * Contract reminders (A-4, ADR-009):
 *  - ConfigResolver only entry point for credentials (NEVER process.env).
 *  - No LLM call, no real network, no shell.
 *  - Errors return { ok: false, error } — NEVER throw to caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feishu } from './feishu.js';

const D = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(D, './feishu.js');

/** Helper: compute HMAC signature the way feishu.verify expects. */
function sign(encryptKey, timestamp, nonce, body) {
  return createHmac('sha256', encryptKey).update(`${timestamp}${nonce}${body}`).digest('hex');
}

// ─── verify action (HMAC-SHA256) ────────────────────────────────
describe('feishu — action: verify', () => {
  // Use an injected resolver via execute({config:{resolver}}) so tests
  // don't depend on real ~/.darwin/.env. The adapter accepts an optional
  // `resolver` override for testability (A-4 friendly).
  const fakeKey = 'test-encrypt-key-1234';
  const fakeResolver = { get: () => ({ encryptKey: fakeKey }) };
  const cfg = () => ({ resolver: fakeResolver });

  test('17. correct HMAC signature → { ok: true }', async () => {
    const body = JSON.stringify({ header: {}, event: {} });
    const ts = '1700000000';
    const nonce = 'abc123';
    const sig = sign(fakeKey, ts, nonce, body);
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: sig, timestamp: ts, nonce, body },
      config: cfg(),
    });
    assert.equal(r.ok, true);
  });

  test('18. incorrect signature → { ok: false, error: "signature mismatch" }', async () => {
    const body = JSON.stringify({});
    const r = await feishu.execute({
      action: 'verify',
      payload: {
        signature: 'deadbeef',
        timestamp: '1700000000',
        nonce: 'n',
        body,
      },
      config: cfg(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'signature mismatch');
  });

  test('19. missing encryptKey (empty config) → { ok: false, error: "no encryptKey configured" } (no throw)', async () => {
    const emptyResolver = { get: () => ({}) };
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: 'x', timestamp: '1', nonce: 'n', body: '{}' },
      config: { resolver: emptyResolver },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no encryptKey configured');
  });

  test('20. no config at all → { ok: false, error: "no config" } (no throw, defaults safe)', async () => {
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: 'x', timestamp: '1', nonce: 'n', body: '{}' },
    });
    assert.equal(r.ok, false);
    assert.ok(/no config|encryptKey/i.test(r.error));
  });
});

// ─── A-4 hygiene ────────────────────────────────────────────────
describe('feishu — A-4 hygiene (no process.env, ConfigResolver is the only path)', () => {
  test('21. source does NOT reference process.env.FEISHU_*', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/process\.env\.FEISHU_/.test(src), 'must not hard-read process.env.FEISHU_*');
  });

  test('22. source imports ConfigResolver from core/config-resolver.js', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(
      /from\s+['"]\.\.\/core\/config-resolver\.js['"]/.test(src) ||
        /from\s+['"]\.\.\/\.\.\/core\/config-resolver\.js['"]/.test(src),
      'must import ConfigResolver from core/',
    );
  });

  test('23. source has no `import fs` / no `node:fs` (adapter is a leaf)', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/from\s+['"]node:fs/.test(src), 'must not import node:fs');
    assert.ok(!/from\s+['"]fs['"]/.test(src), 'must not import fs');
  });

  test('24. source has no execSync / no shell', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/execSync/.test(src), 'must not use execSync');
    assert.ok(!/node:child_process/.test(src), 'must not import child_process');
  });
});
