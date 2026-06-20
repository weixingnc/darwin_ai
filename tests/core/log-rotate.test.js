/**
 * core/log-rotate tests (v14).
 *
 * Covers: timestampForRotation, archivePathFor, listArchives,
 * rotateIfNeeded (async), rotateIfNeededSync. Uses tmp dirs so no
 * production log files are touched.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  timestampForRotation,
  archivePathFor,
  listArchives,
  rotateIfNeeded,
  rotateIfNeededSync,
  pruneArchives,
} from '../../core/log-rotate.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'darwin-logrotate-'));
});
after(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeBig(path, bytes) {
  // Write a JSONL file with `bytes` total size; each line ~ 64 bytes.
  const line = JSON.stringify({ ts: '2026-06-20T10:00:00.000Z', padding: 'x'.repeat(40) }) + '\n';
  let written = 0;
  let count = 0;
  while (written + line.length <= bytes) {
    writeFileSync(path, line, { flag: count === 0 ? 'w' : 'a' });
    written += line.length;
    count += 1;
  }
  return count;
}

describe('log-rotate -- helpers', () => {
  test('timestampForRotation: YYYY-MM-DDTHH-mm-ss UTC', () => {
    const d = new Date(Date.UTC(2026, 5, 20, 9, 5, 7)); // June=5
    assert.equal(timestampForRotation(d), '2026-06-20T09-05-07');
  });

  test('archivePathFor: zero seq = no suffix, seq>0 = -N suffix', () => {
    const d = new Date(Date.UTC(2026, 5, 20, 9, 5, 7));
    assert.equal(
      archivePathFor('/tmp/x/catalogue.log', d, 0),
      '/tmp/x/catalogue.log.2026-06-20T09-05-07.rotated',
    );
    assert.equal(
      archivePathFor('/tmp/x/catalogue.log', d, 3),
      '/tmp/x/catalogue.log.2026-06-20T09-05-07-3.rotated',
    );
  });
});

describe('log-rotate -- rotateIfNeeded (async)', () => {
  test('missing file: no rotation, returns zeroed result', async () => {
    const r = await rotateIfNeeded(join(dir, 'never-existed.log'));
    assert.equal(r.rotated, false);
    assert.equal(r.archivedTo, null);
    assert.equal(r.sizeBefore, 0);
  });

  test('under threshold: no rotation, returns sizeBefore=sizeAfter', async () => {
    const p = join(dir, 'small.log');
    writeFileSync(p, 'tiny\n');
    const r = await rotateIfNeeded(p, { maxBytes: 1024 });
    assert.equal(r.rotated, false);
    assert.equal(r.sizeBefore, 5);
    assert.equal(r.sizeAfter, 5);
    // file still exists with same content
    assert.ok(readFileSync(p, 'utf8').includes('tiny'));
  });

  test('over threshold: rotates to .rotated sibling, returns metadata', async () => {
    const p = join(dir, 'big.log');
    writeBig(p, 2048); // 2 KB
    const before = statSync(p).size;
    assert.ok(before > 1024, 'precondition: file is bigger than maxBytes');
    const r = await rotateIfNeeded(p, { maxBytes: 1024 });
    assert.equal(r.rotated, true);
    assert.ok(r.archivedTo.endsWith('.rotated'));
    assert.equal(r.sizeBefore, before);
    assert.equal(r.sizeAfter, 0);
    // The source file no longer exists (rename moved it).
    let sourceExists = true;
    try {
      statSync(p);
    } catch {
      sourceExists = false;
    }
    assert.equal(sourceExists, false);
    // The archive file exists and has the original size.
    const archiveSize = statSync(r.archivedTo).size;
    assert.equal(archiveSize, before);
  });

  test('over threshold: keeps at most maxFiles archives (oldest pruned)', async () => {
    const p = join(dir, 'prune.log');
    for (let i = 0; i < 5; i += 1) {
      writeBig(p, 2048);
      await rotateIfNeeded(p, { maxBytes: 512, maxFiles: 2 });
    }
    const archives = await listArchives(p);
    assert.ok(archives.length <= 2, `expected <=2 archives, got ${archives.length}`);
  });

  test('listArchives: returns only .rotated siblings, newest-first', async () => {
    const p = join(dir, 'listed.log');
    writeBig(p, 1024);
    const fixedNow = new Date(Date.UTC(2026, 5, 20, 10, 0, 0));
    await rotateIfNeeded(p, { maxBytes: 256, now: fixedNow });
    writeBig(p, 1024);
    await rotateIfNeeded(p, { maxBytes: 256, now: new Date(fixedNow.getTime() + 5000) });
    const archives = await listArchives(p);
    assert.ok(archives.length >= 2);
    for (let i = 1; i < archives.length; i += 1) {
      assert.ok(archives[i - 1].mtimeMs >= archives[i].mtimeMs);
    }
  });
});

describe('log-rotate -- rotateIfNeededSync', () => {
  test('returns same shape as async variant', () => {
    const p = join(dir, 'sync-big.log');
    writeBig(p, 1024);
    const r = rotateIfNeededSync(p, { maxBytes: 256 });
    assert.equal(r.rotated, true);
    assert.equal(r.sizeAfter, 0);
    assert.ok(r.archivedTo.endsWith('.rotated'));
  });

  test('no-op on small file: same sizeBefore == sizeAfter', () => {
    const p = join(dir, 'sync-small.log');
    writeFileSync(p, 'small\n');
    const r = rotateIfNeededSync(p, { maxBytes: 1024 });
    assert.equal(r.rotated, false);
    assert.equal(r.sizeBefore, 6);
    assert.equal(r.sizeAfter, 6);
  });

  test('prunes oldest archives beyond maxFiles', () => {
    const p = join(dir, 'sync-prune.log');
    for (let i = 0; i < 4; i += 1) {
      writeBig(p, 1024);
      rotateIfNeededSync(p, { maxBytes: 256, maxFiles: 2 });
    }
    const all = readdirSync(dir).filter(
      (n) => n.startsWith('sync-prune.log.') && n.endsWith('.rotated'),
    );
    assert.ok(
      all.length <= 2,
      `expected <=2 archives after sync prunes, got ${all.length}: ${all.join(',')}`,
    );
  });
});

describe('log-rotate -- pruneArchives', () => {
  test('keeps maxFiles newest, deletes the rest', async () => {
    const p = join(dir, 'prune-direct.log');
    for (let i = 0; i < 6; i += 1) {
      writeBig(p, 1024);
      await rotateIfNeeded(p, { maxBytes: 256, now: new Date(Date.UTC(2026, 5, 20, 12, 0, i)) });
    }
    const deleted = await pruneArchives(p, 3);
    const remaining = await listArchives(p);
    assert.equal(remaining.length, 3);
    assert.equal(deleted.length, 3);
  });
});
