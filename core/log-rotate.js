/**
 * core/log-rotate -- size-based rotation for append-only JSONL logs.
 *
 * v14: log rotate policy. Hooks into:
 *   - evolution/catalogue.js  (catalogue.log, ~646 lines, 192K at v14)
 *   - plugin/audit.js         (audit.jsonl, ~1940 lines, 205K at v14)
 *
 * Both write via `fs.appendFileSync(path, JSON.stringify(entry) + '\n')`.
 * Before each append, the writer calls `rotateIfNeededSync(path, opts)` to
 * check size and rotate if over threshold. This keeps the active log small
 * and predictable while preserving the full history in `.rotated` files.
 *
 * Rotation policy (V14, conservative defaults):
 *   - Threshold: 512 KB (configurable per caller)
 *   - Archive pattern: `${path}.${YYYY-MM-DDTHH-mm-ss}.${seq}.rotated`
 *   - maxFiles (per source path): 10 archives kept; oldest pruned
 *   - Atomic: rename in-place; no truncation; no read-modify-write
 *
 * Read API (V17 prep):
 *   - listArchives(path) returns the main file + all `.rotated` siblings,
 *     newest-first. Use this for `darwin audit query` so rotated history
 *     is queryable.
 *
 * No LLM. No external API. Pure node:fs.
 */

import { stat, rename, readdir } from 'node:fs/promises';
// unlink async not imported -- sync variant used
import { statSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB
const DEFAULT_MAX_FILES = 10; // keep 10 archives per source

/**
 * Stamp a JS Date as `YYYY-MM-DDTHH-mm-ss` (filesystem-safe ISO).
 * @param {Date} d
 * @returns {string}
 */
export function timestampForRotation(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    '-' +
    pad(d.getUTCMinutes()) +
    '-' +
    pad(d.getUTCSeconds())
  );
}

/**
 * Build the archive filename for a rotation. Pattern:
 *   `${basename}.${timestamp}.${seq}.rotated`
 * where `seq` resolves duplicate timestamps within the same second.
 *
 * @param {string} sourcePath  the active log file path
 * @param {Date}   d
 * @param {number} seq         0..n for same-second rotations
 * @returns {string}  full archive path (same dir as source)
 */
export function archivePathFor(sourcePath, d = new Date(), seq = 0) {
  const dir = dirname(sourcePath);
  const base = basename(sourcePath);
  const stamp = timestampForRotation(d);
  const suffix = seq === 0 ? '' : `-${seq}`;
  return join(dir, `${base}.${stamp}${suffix}.rotated`);
}

/**
 * Pick the next non-colliding archive path for `sourcePath` at time `now`.
 * Same-second rotations get a `-1`, `-2`, ... suffix. Caps at seq=99.
 *
 * @param {string} sourcePath
 * @param {Date}   now
 * @returns {string|null}  null if 100+ collisions (pathological)
 */
function nextArchivePath(sourcePath, now) {
  for (let seq = 0; seq < 100; seq += 1) {
    const target = archivePathFor(sourcePath, now, seq);
    if (!existsSync(target)) {
      return target;
    }
  }
  return null;
}

/**
 * List archive files for a given active log path, newest-first.
 * An archive is a sibling whose name matches `${base}.*.rotated`.
 *
 * @param {string} sourcePath
 * @returns {Promise<Array<{path:string, mtimeMs:number, size:number}>>}
 */
export async function listArchives(sourcePath) {
  const dir = dirname(sourcePath);
  const base = basename(sourcePath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    if (!e.name.startsWith(`${base}.`) || !e.name.endsWith('.rotated')) {
      continue;
    }
    const full = join(dir, e.name);
    try {
      const st = await stat(full);
      out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function pruneArchivesByList(sourcePath, archives, maxFiles) {
  if (archives.length <= maxFiles) {
    return [];
  }
  const toDelete = archives.slice(maxFiles);
  const deleted = [];
  for (const a of toDelete) {
    try {
      unlinkSync(a.path);
      deleted.push(a.path);
    } catch {
      /* swallow; another process may have it */
    }
  }
  return deleted;
}

/**
 * Async variant: list current archives, then prune oldest beyond
 * `maxFiles`. Returns the list of paths deleted.
 *
 * @param {string} sourcePath
 * @param {number} maxFiles  default 10
 * @returns {Promise<string[]>}
 */
export async function pruneArchives(sourcePath, maxFiles = DEFAULT_MAX_FILES) {
  const archives = await listArchives(sourcePath);
  return pruneArchivesByList(sourcePath, archives, maxFiles);
}

/**
 * Async rotation. See rotateIfNeededSync for the sync variant used by
 * appendFileSync callers.
 *
 * @param {string} sourcePath
 * @param {object} [opts]
 * @returns {Promise<{rotated:boolean, archivedTo:string|null, sizeBefore:number, sizeAfter:number, pruned:string[]}>}
 */
export async function rotateIfNeeded(sourcePath, opts = {}) {
  const maxBytes =
    Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles =
    Number.isInteger(opts.maxFiles) && opts.maxFiles >= 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let st;
  try {
    st = await stat(sourcePath);
  } catch {
    return { rotated: false, archivedTo: null, sizeBefore: 0, sizeAfter: 0, pruned: [] };
  }
  if (!st.isFile() || st.size <= maxBytes) {
    return {
      rotated: false,
      archivedTo: null,
      sizeBefore: st.size,
      sizeAfter: st.size,
      pruned: [],
    };
  }

  const target = nextArchivePath(sourcePath, now);
  if (!target) {
    return {
      rotated: false,
      archivedTo: null,
      sizeBefore: st.size,
      sizeAfter: st.size,
      pruned: [],
    };
  }
  await rename(sourcePath, target);
  const pruned = await pruneArchives(sourcePath, maxFiles);
  return {
    rotated: true,
    archivedTo: target,
    sizeBefore: st.size,
    sizeAfter: 0,
    pruned,
  };
}

/**
 * Sync rotation. Use this from appendFileSync callers (catalogue.js,
 * audit.js). Same contract as rotateIfNeeded but blocking.
 *
 * @param {string} sourcePath
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=524288]
 * @param {number} [opts.maxFiles=10]
 * @param {Date}   [opts.now=new Date()]
 * @returns {{rotated:boolean, archivedTo:string|null, sizeBefore:number, sizeAfter:number, pruned:string[]}}
 */
export function rotateIfNeededSync(sourcePath, opts = {}) {
  const maxBytes =
    Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles =
    Number.isInteger(opts.maxFiles) && opts.maxFiles >= 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let st;
  try {
    st = statSync(sourcePath);
  } catch {
    return { rotated: false, archivedTo: null, sizeBefore: 0, sizeAfter: 0, pruned: [] };
  }
  if (!st.isFile() || st.size <= maxBytes) {
    return {
      rotated: false,
      archivedTo: null,
      sizeBefore: st.size,
      sizeAfter: st.size,
      pruned: [],
    };
  }
  const target = nextArchivePath(sourcePath, now);
  if (!target) {
    return {
      rotated: false,
      archivedTo: null,
      sizeBefore: st.size,
      sizeAfter: st.size,
      pruned: [],
    };
  }
  renameSync(sourcePath, target);

  // Prune oldest archives via sync I/O (we are already in sync land).
  const dir = dirname(sourcePath);
  const base = basename(sourcePath);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const archives = [];
  for (const n of entries) {
    if (!n.startsWith(`${base}.`) || !n.endsWith('.rotated')) {
      continue;
    }
    const full = join(dir, n);
    try {
      archives.push({ path: full, mtimeMs: statSync(full).mtimeMs });
    } catch {
      /* skip */
    }
  }
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pruned = pruneArchivesByList(sourcePath, archives, maxFiles);
  return {
    rotated: true,
    archivedTo: target,
    sizeBefore: st.size,
    sizeAfter: 0,
    pruned,
  };
}
