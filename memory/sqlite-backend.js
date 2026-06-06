/**
 * SqliteBackend: sqlite-backed IMemory — Darwin's "永生" layer.
 * Persists key/value pairs in a single sqlite file; ACID, cross-platform,
 * zero external dependencies (uses node:sqlite, built into Node 22.5+).
 *
 * v2 design (PR 17): plain-object factory, IMemory-shaped. init() pulls
 * config via ConfigResolver (A-4: NEVER process.env). All IO wrapped in
 * ErrorHandler; errors surface via EventBus; NEVER throw (A-5: EventBus only).
 *
 * Schema (single table):
 *   darwin_memory(key TEXT PRIMARY KEY, value TEXT, ts INTEGER, ttl INTEGER)
 *   - value: JSON.stringify of any JS value
 *   - ts:    Date.now() at write time
 *   - ttl:   0 = never expire (永生); >0 = ms until expiry
 *
 * Hygiene (red line): no hard-coded paths, no real credentials. The
 * persistence path is provided by ConfigResolver from the user-overridable
 * example config block (memory-default.path). Tests use :memory:.
 *
 * Multi-tenant registry convention: filesystem + sqlite + vector coexist.
 */

import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `CREATE TABLE IF NOT EXISTS darwin_memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 0
)`;

/** Sanitize a user-provided key (no NUL bytes; sqlite stores any string). */
function safeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return null;
  }
  if (key.includes('\0')) {
    return null;
  }
  return key;
}

/** Emit a structured MEMORY_*_ERROR on the bus from an ErrorHandler entry. */
function emitErr(b, evt, ctx, err) {
  b._bus?.emit(evt, { ...err, context: { context: ctx } });
}

/** SqliteBackend factory. Returns a fresh IMemory-shaped plain object. */
export function SqliteBackend() {
  const b = {
    name: 'sqlite',
    version: '1.0.0',
    capabilities: ['key-value', 'persist', 'query', 'list', 'delete', 'ttl'],
    _bus: null,
    _db: null,
    _dbPath: null,
    _resolvedConfig: null,

    /** Init: pull config via ConfigResolver, open DatabaseSync, exec schema. NEVER throws. */
    async init(ctx) {
      const r = await ErrorHandler.wrapAsync(
        async () => {
          if (!ctx?.eventBus || !ctx?.config) {
            throw new TypeError('[SqliteBackend] init: ctx.eventBus and ctx.config are required');
          }
          b._bus = ctx.eventBus;
          // A-4: ALL config via ConfigResolver. Never read process.env directly.
          const resolved = ctx.config.get('memory-default') || {};
          b._resolvedConfig = resolved;
          b._dbPath =
            typeof resolved.path === 'string' && resolved.path.length > 0
              ? resolved.path
              : ':memory:';
          b._db = new DatabaseSync(b._dbPath);
          b._db.exec(SCHEMA);
        },
        { context: 'memory.sqlite.init' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.sqlite.init', r.error);
      }
    },

    /** Get a value by key. Returns null on miss / expiry / IO error. NEVER throws. */
    async get(key) {
      const k = safeKey(key);
      if (k === null) {
        return null;
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const row = b._db
            .prepare('SELECT value, ts, ttl FROM darwin_memory WHERE key = ?')
            .get(k);
          if (!row) {
            return null;
          }
          // TTL check: ts + ttl < now → expired → delete + return null
          if (row.ttl > 0 && row.ts + row.ttl < Date.now()) {
            b._db.prepare('DELETE FROM darwin_memory WHERE key = ?').run(k);
            return null;
          }
          return JSON.parse(row.value);
        },
        { context: 'memory.sqlite.get' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.sqlite.get', r.error);
        return null;
      }
      return r.value;
    },

    /** Set a key/value pair with optional ttl (ms). ttl=0 (default) = 永生. NEVER throws. */
    async set(key, value, ttl) {
      const k = safeKey(key);
      if (k === null) {
        return { ok: false };
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const now = Date.now();
          const t = typeof ttl === 'number' && ttl > 0 ? ttl : 0;
          b._db
            .prepare('REPLACE INTO darwin_memory (key, value, ts, ttl) VALUES (?, ?, ?, ?)')
            .run(k, JSON.stringify(value), now, t);
        },
        { context: 'memory.sqlite.set' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_SET_ERROR, 'memory.sqlite.set', r.error);
        return { ok: false };
      }
      return { ok: true };
    },

    /** Delete a key. Returns { ok, count }. Silent on missing. NEVER throws. */
    async delete(key) {
      const k = safeKey(key);
      if (k === null) {
        return { ok: true, count: 0 };
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const info = b._db.prepare('DELETE FROM darwin_memory WHERE key = ?').run(k);
          return info.changes;
        },
        { context: 'memory.sqlite.delete' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_DELETE_ERROR, 'memory.sqlite.delete', r.error);
        return { ok: false };
      }
      return { ok: true, count: r.value };
    },

    /** Has: true if key exists and not expired. NEVER throws. */
    async has(key) {
      const k = safeKey(key);
      if (k === null) {
        return false;
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const row = b._db.prepare('SELECT 1 FROM darwin_memory WHERE key = ?').get(k);
          if (!row) {
            return false;
          }
          // TTL re-check (key may have expired since write)
          const meta = b._db.prepare('SELECT ts, ttl FROM darwin_memory WHERE key = ?').get(k);
          if (meta && meta.ttl > 0 && meta.ts + meta.ttl < Date.now()) {
            b._db.prepare('DELETE FROM darwin_memory WHERE key = ?').run(k);
            return false;
          }
          return true;
        },
        { context: 'memory.sqlite.has' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.sqlite.has', r.error);
        return false;
      }
      return r.value;
    },

    /** List keys (sorted), optionally filtered by prefix. NEVER throws. */
    async list(prefix) {
      const pref = typeof prefix === 'string' ? prefix : '';
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const rows = b._db
            .prepare('SELECT key FROM darwin_memory WHERE key LIKE ? ORDER BY key')
            .all(pref + '%');
          return rows.map((row) => row.key);
        },
        { context: 'memory.sqlite.list' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_LIST_ERROR, 'memory.sqlite.list', r.error);
        return [];
      }
      return r.value;
    },

    /** Wipe all rows. Returns { ok, count }. NEVER throws. */
    async clear() {
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const info = b._db.prepare('DELETE FROM darwin_memory').run();
          return info.changes;
        },
        { context: 'memory.sqlite.clear' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_CLEAR_ERROR, 'memory.sqlite.clear', r.error);
        return { ok: false };
      }
      return { ok: true, count: r.value };
    },

    /** Destroy: close db, drop refs. Idempotent. NEVER throws. */
    async destroy() {
      if (b._db) {
        try {
          b._db.close();
        } catch {
          /* idempotent close */
        }
      }
      b._db = null;
      b._bus = null;
      b._resolvedConfig = null;
    },

    /** Validate: self-checks name + get/set presence. */
    validate() {
      return (
        this.name === 'sqlite' && typeof this.get === 'function' && typeof this.set === 'function'
      );
    },
  };
  return b;
}
