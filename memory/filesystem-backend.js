/**
 * FilesystemBackend: filesystem-backed IMemory — Darwin's "永生" layer.
 * Persists key/value pairs as JSON files under a configurable directory;
 * survives process restarts.
 *
 * v2 design (PR 13b): plain-object factory, IMemory-shaped. init() pulls
 * config via ConfigResolver (A-4: NEVER process.env). All IO wrapped in
 * ErrorHandler; errors surface via EventBus; NEVER throw (A-5: EventBus only).
 *
 * File format (per key): ${path}/${key}.json
 *   { "value": <any>, "meta": { createdAt, updatedAt, expiresAt, ttl } }
 *
 * Hygiene (red line): no hard-coded paths, no real credentials. The
 * persistence path is provided by ConfigResolver from the user-overridable
 * example config block (memory-default.path). Tests use tmpdir.
 *
 * Multi-tenant registry convention: filesystem + sqlite + vector coexist.
 */

import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';
import { access, mkdir, readFile, writeFile, unlink, readdir, rm, constants as F } from 'node:fs/promises';
import { join } from 'node:path';

/** Sanitize a user-provided key (no path separators, no '..', no NUL). */
function safeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {return null;}
  if (key.includes('/') || key.includes('\\') || key.includes('..') || key.includes('\0')) {return null;}
  return key;
}

/** Emit a structured MEMORY_*_ERROR on the bus from an ErrorHandler entry. */
function emitErr(b, evt, ctx, err) {
  b._bus?.emit(evt, { ...err, context: { context: ctx } });
}

/** List sorted .json filenames in the path (basename only). ENOENT → []. */
async function listKeys(b) {
  let entries;
  try { entries = await readdir(b._path); }
  catch (err) {
    if (err && err.code === 'ENOENT') {return [];}
    throw err;
  }
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/** FilesystemBackend factory. Returns a fresh IMemory-shaped plain object. */
export function FilesystemBackend() {
  const b = {
    name: 'filesystem',
    version: '1.0.0',
    capabilities: ['key-value', 'persist', 'query', 'list', 'delete', 'ttl'],
    _bus: null,
    _resolvedConfig: null,
    _path: null,
    _meta: new Map(),

    /** Init: pull config via ConfigResolver, mkdir, verify writability. NEVER throws. */
    async init(ctx) {
      const r1 = await ErrorHandler.wrapAsync(async () => {
        if (!ctx?.eventBus || !ctx?.config) {
          throw new TypeError('[FilesystemBackend] init: ctx.eventBus and ctx.config are required');
        }
        b._bus = ctx.eventBus;
        // A-4: ALL config via ConfigResolver. Never read process.env directly.
        const resolved = ctx.config.get('memory-default') || {};
        b._resolvedConfig = resolved;
        b._path = resolved.path;
        if (typeof b._path !== 'string' || b._path.length === 0) {
          throw new Error('[FilesystemBackend] init: memory-default.path is required');
        }
      }, { context: 'memory.filesystem.init.config' })();
      if (!r1.ok) { emitErr(b, EVENTS.MEMORY_GET_ERROR_MEMORY, 'memory.filesystem.init', r1.error); return; }
      const r2 = await ErrorHandler.wrapAsync(async () => {
        await mkdir(b._path, { recursive: true });
        await access(b._path, F.W_OK);
      }, { context: 'memory.filesystem.init.mkdir' })();
      if (!r2.ok) {emitErr(b, EVENTS.MEMORY_GET_ERROR_MEMORY, 'memory.filesystem.init', r2.error);}
    },

    /** Get a value by key. Returns null on miss / expiry / IO error. NEVER throws. */
    async get(key) {
      const k = safeKey(key);
      if (k === null) {return null;}
      const r = await ErrorHandler.wrapAsync(async () => {
        const meta = b._meta.get(k);
        const now = Date.now();
        if (meta && typeof meta.expiresAt === 'number' && meta.expiresAt < now) {
          b._meta.delete(k);
          try { await unlink(b._filePath(k)); } catch { /* secondary ignored */ }
          return null;
        }
        let raw;
        try { raw = await readFile(b._filePath(k), 'utf8'); }
        catch (err) {
          if (err && err.code === 'ENOENT') { b._meta.delete(k); return null; }
          throw err;
        }
        const parsed = JSON.parse(raw);
        if (!b._meta.has(k) && parsed?.meta) {b._meta.set(k, parsed.meta);}
        return parsed?.value ?? null;
      }, { context: 'memory.filesystem.get' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.filesystem.get', r.error); return null; }
      return r.value;
    },

    /** Set a key/value pair with optional ttl (ms). NEVER throws. */
    async set(key, value, ttl) {
      const k = safeKey(key);
      if (k === null) {return { ok: false, error: { message: 'invalid key' } };}
      const now = Date.now();
      const meta = {
        createdAt: b._meta.get(k)?.createdAt || now,
        updatedAt: now,
        expiresAt: typeof ttl === 'number' && ttl > 0 ? now + ttl : null,
        ttl: typeof ttl === 'number' && ttl > 0 ? ttl : null,
      };
      const r = await ErrorHandler.wrapAsync(async () => {
        b._meta.set(k, meta);
        await writeFile(b._filePath(k), JSON.stringify({ value, meta }), 'utf8');
      }, { context: 'memory.filesystem.set' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_SET_ERROR, 'memory.filesystem.set', r.error); return { ok: false }; }
      return { ok: true };
    },

    /** Delete a key. Silent on missing. NEVER throws. */
    async delete(key) {
      const k = safeKey(key);
      if (k === null) {return { ok: true };}
      b._meta.delete(k);
      const r = await ErrorHandler.wrapAsync(async () => {
        try { await unlink(b._filePath(k)); }
        catch (err) { if (err && err.code === 'ENOENT') {return;} throw err; }
      }, { context: 'memory.filesystem.delete' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_DELETE_ERROR, 'memory.filesystem.delete', r.error); return { ok: false }; }
      return { ok: true };
    },

    /** List keys (sorted), optionally filtered by prefix. NEVER throws. */
    async list(prefix) {
      const pref = typeof prefix === 'string' ? prefix : '';
      const r = await ErrorHandler.wrapAsync(async () => (await listKeys(b)).filter((k) => k.startsWith(pref)),
        { context: 'memory.filesystem.list' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_LIST_ERROR, 'memory.filesystem.list', r.error); return []; }
      return r.value;
    },

    /** Query keys (sorted) by regex source string. NEVER throws. */
    async query(pattern) {
      const r = await ErrorHandler.wrapAsync(async () => {
        let re;
        try { re = new RegExp(typeof pattern === 'string' ? pattern : ''); } catch { return []; }
        return (await listKeys(b)).filter((k) => re.test(k));
      }, { context: 'memory.filesystem.query' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_QUERY_ERROR, 'memory.filesystem.query', r.error); return []; }
      return r.value;
    },

    /** Wipe all keys and recreate the path. NEVER throws. */
    async clear() {
      const r = await ErrorHandler.wrapAsync(async () => {
        try { await rm(b._path, { recursive: true, force: true }); }
        catch (err) { if (!(err && err.code === 'ENOENT')) {throw err;} }
        await mkdir(b._path, { recursive: true });
        b._meta.clear();
      }, { context: 'memory.filesystem.clear' })();
      if (!r.ok) { emitErr(b, EVENTS.MEMORY_CLEAR_ERROR, 'memory.filesystem.clear', r.error); return { ok: false }; }
      return { ok: true };
    },

    /** Destroy: clear in-memory meta only. Disk is authoritative. Idempotent. */
    destroy() {
      this._meta.clear();
      this._bus = null;
      this._resolvedConfig = null;
      this._path = null;
    },

    /** private: build the on-disk filename for a key */
    _filePath(key) {
      return join(this._path, `${key}.json`);
    },
  };
  return b;
}
