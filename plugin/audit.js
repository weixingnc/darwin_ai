/**
 * audit — Darwin self-evolution audit plugin (P2c-2 + P2j, 2026-06-18).
 *
 * Production plugin (NOT the P2c-1 manifest stub): subscribes to Darwin's
 * evolution events and persists them. P2c-2 was the first non-example
 * production plugin in `plugin/` — the "装新器官" half of Darwin's
 * self-evolution closed loop. P2j (2026-06-18) upgrades the persistence
 * layer from in-memory to append-only JSONL on disk:
 *
 *   Darwin (diagnose → propose → apply) → emits evolution:* events
 *                                          ↓
 *                                  audit plugin records them
 *                                          ↓
 *                            append to <baseDir>/audit.jsonl
 *                                          ↓
 *                       host calls audit.getEvents() for in-memory
 *                       snapshot, or reads audit.jsonl directly for
 *                       post-restart replay.
 *
 * Manifest (P2d contract, validated by IPlugin.validate at load time):
 *   - name         'audit'             (lowercase, non-empty)
 *   - version      '0.2.0'             (P2j: bumped from 0.1.0)
 *   - capabilities ['tool']            (PLUGIN_CAPABILITIES category)
 *   - permissions  ['bus:on', 'log:info', 'fs:append']
 *                                       (P2j: 'fs:append' added — audit
 *                                        needs to append entries to
 *                                        audit.jsonl. fs:append is in
 *                                        PLUGIN_PERMISSIONS (not in
 *                                        PLUGIN_DENIED) because it's
 *                                        append-only, cannot overwrite
 *                                        or delete. Static manifest
 *                                        check accepts; runtime sandbox
 *                                        (P2e) only blocks if
 *                                        enableSandbox=true on loader.)
 *
 * Lifecycle:
 *   init(ctx)   subscribe to evolution:propose:after + evolution:apply:after
 *               via ctx.eventBus; reset in-memory log; bind baseDir
 *               from ctx.config (defaults to <cwd>/memory/audit);
 *               recording = true
 *   enable()    recording = true (default after init)
 *   disable()   recording = false (events keep firing but are dropped)
 *   destroy()   unsubscribe both topics, clear in-memory log
 *
 * Public API (in addition to IPlugin lifecycle):
 *   getEvents()           → Array<{topic, payload, recordedAt}> (in-memory)
 *   getLogPath()          → string (absolute path to audit.jsonl)
 *   readPersisted()       → Array<{topic, payload, recordedAt}> from disk
 *                           (post-restart replay — independent of in-memory)
 */

import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'audit',
  version: '0.2.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info', 'fs:append'],

  init(ctx) {
    this._bus = ctx.eventBus;
    this._events = [];
    this._recording = true;
    // P2j: persist to <baseDir>/audit.jsonl. ctx.config may be undefined
    // (e.g. plugin loaded via discovery without config wiring) — fall back
    // to env DARWIN_AUDIT_DIR or './memory/audit'.
    const configDir = ctx.config?.baseDir || process.env.DARWIN_AUDIT_DIR;
    const baseDir =
      configDir ||
      path.join(process.cwd(), 'memory', 'audit');
    this._baseDir = baseDir;
    this._logPath = path.join(baseDir, 'audit.jsonl');
    this._handlers = {
      'evolution:propose:after': (payload) => this._record('evolution:propose:after', payload),
      'evolution:apply:after': (payload) => this._record('evolution:apply:after', payload),
    };
    for (const [topic, fn] of Object.entries(this._handlers)) {
      this._bus.on(topic, fn);
    }
  },

  enable() {
    this._recording = true;
  },

  disable() {
    this._recording = false;
  },

  destroy() {
    if (this._bus && this._handlers) {
      for (const [topic, fn] of Object.entries(this._handlers)) {
        this._bus.off(topic, fn);
      }
    }
    this._handlers = null;
    this._events = [];
    this._bus = null;
  },

  /**
   * P2c-2: return the in-memory log of evolution events recorded since
   * init(). Each entry is {topic, payload, recordedAt}.
   * Returns a shallow copy so callers can't mutate internal state.
   */
  getEvents() {
    return Array.isArray(this._events) ? [...this._events] : [];
  },

  /** P2j: absolute path to the persisted audit.jsonl. */
  getLogPath() {
    return this._logPath;
  },

  /**
   * P2j: read the persisted audit log from disk (post-restart replay).
   * Independent of the in-memory log — survives process restarts.
   * Returns [] if the file doesn't exist yet.
   * Skips malformed lines (logs them to stderr but doesn't throw).
   */
  readPersisted() {
    let raw;
    try {
      raw = fs.readFileSync(this._logPath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(line));
      } catch {
        process.stderr.write(`[audit] malformed line skipped: ${line.slice(0, 80)}\n`);
      }
    }
    return out;
  },

  // Internal: append a recorded event to in-memory log AND to disk.
  _record(topic, payload) {
    if (!this._recording) {
      return;
    }
    const entry = {
      topic,
      payload,
      recordedAt: new Date().toISOString(),
    };
    this._events.push(entry);
    // P2j: persist synchronously to disk. Use appendFileSync (no read
    // first) — survives process kill (the file is closed after each
    // append). For high-volume events this would batch, but Darwin's
    // evolution events are infrequent (propose + apply per cycle).
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      fs.appendFileSync(this._logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // Don't crash the plugin if disk write fails — log to stderr
      // so the in-memory snapshot is still useful.
      process.stderr.write(`[audit] persist failed: ${err.message}\n`);
    }
  },
};
