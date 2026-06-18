/**
 * metrics — Darwin self-evolution metrics plugin (W4-1, 2026-06-18).
 *
 * Production plugin (3rd production plugin in plugin/, after audit):
 *   plugin/logger.js   (P2d example, always loaded)
 *   plugin/audit.js    (P2c-2 + P2j, records evolution events to JSONL)
 *   plugin/metrics.js  (W4-1, aggregates evolution event counts +
 *                              duration stats — observability layer)
 *
 * Where audit records WHAT happened, metrics records HOW MUCH and
 * HOW FAST. metrics subscribes to a broader set of evolution events
 * (diagnose/propose/apply/verify/rollback) and tracks per-topic
 * counters + running average duration. Exposes a getStats() API so
 * a host (or another plugin) can introspect Darwin's own heartbeat.
 *
 * Manifest (P2d contract, validated by IPlugin.validate at load time):
 *   - name         'metrics'           (lowercase, non-empty)
 *   - version      '0.1.0'             (W4-1: initial)
 *   - capabilities ['tool']            (PLUGIN_CAPABILITIES category)
 *   - permissions  ['bus:on', 'log:info', 'fs:append']
 *                                       (fs:append for stats.jsonl
 *                                        persistence, P2j-pattern)
 *
 * Lifecycle:
 *   init(ctx)   subscribe to 5 evolution:* events via ctx.eventBus;
 *               bind baseDir from ctx.config (defaults to
 *               <cwd>/memory/metrics); recording = true
 *   enable()    recording = true
 *   disable()   recording = false (events still fire, dropped)
 *   destroy()   unsubscribe all topics, clear in-memory stats
 *
 * Public API (in addition to IPlugin lifecycle):
 *   getStats()        → {events_by_topic, total_events,
 *                        avg_duration_ms, last_event_at}
 *   getLogPath()      → string (absolute path to stats.jsonl)
 *   readPersisted()   → Array<{topic, duration_ms, recordedAt}> from disk
 *
 * Design notes:
 *   - Duration measurement: the metrics plugin doesn't measure
 *     durations itself — events that carry `duration_ms` in their
 *     payload contribute to the average. Events without duration_ms
 *     contribute to event count only. This keeps the plugin simple:
 *     no timers, no clock drift, no setTimeout cleanup.
 *   - 'events_by_topic' is a Map → plain object on getStats() so
 *     JSON.stringify works for any consumer.
 *   - The plugin is independent of audit (different concerns). A
 *     Darwin could load both; they observe the same bus but persist
 *     to different files.
 */

import fs from 'node:fs';
import path from 'node:path';

const TRACKED_TOPICS = [
  'evolution:diagnose:after',
  'evolution:propose:after',
  'evolution:apply:after',
  'evolution:verify:after',
  'evolution:rollback:after',
];

export default {
  name: 'metrics',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info', 'fs:append'],

  init(ctx) {
    this._bus = ctx.eventBus;
    this._recording = true;
    // Per-topic event counters + duration accumulators.
    this._eventsByTopic = {};
    this._durationSumByTopic = {};
    this._durationCountByTopic = {};
    this._totalEvents = 0;
    this._totalDurationSum = 0;
    this._totalDurationCount = 0;
    this._lastEventAt = null;
    // P2j-pattern persistence: baseDir from ctx.config > env > cwd default.
    const configDir = ctx.config?.baseDir || process.env.DARWIN_METRICS_DIR;
    const baseDir =
      configDir ||
      path.join(process.cwd(), 'memory', 'metrics');
    this._baseDir = baseDir;
    this._logPath = path.join(baseDir, 'stats.jsonl');
    this._handlers = {};
    for (const topic of TRACKED_TOPICS) {
      this._handlers[topic] = (payload) => this._record(topic, payload);
      this._bus.on(topic, this._handlers[topic]);
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
      for (const topic of Object.keys(this._handlers)) {
        this._bus.off(topic, this._handlers[topic]);
      }
    }
    this._handlers = {};
    this._bus = null;
  },

  /**
   * W4-1: aggregate metrics. Returns a plain object (Map → object
   * conversion for JSON.stringify compatibility). Per-topic counts
   * + global totals + global avg duration.
   */
  getStats() {
    const eventsByTopic = {};
    const avgDurationByTopic = {};
    for (const topic of Object.keys(this._eventsByTopic)) {
      eventsByTopic[topic] = this._eventsByTopic[topic];
      const dc = this._durationCountByTopic[topic] || 0;
      avgDurationByTopic[topic] =
        dc > 0 ? this._durationSumByTopic[topic] / dc : null;
    }
    return {
      events_by_topic: eventsByTopic,
      avg_duration_ms_by_topic: avgDurationByTopic,
      total_events: this._totalEvents,
      avg_duration_ms:
        this._totalDurationCount > 0
          ? this._totalDurationSum / this._totalDurationCount
          : null,
      last_event_at: this._lastEventAt,
    };
  },

  /** W4-1: absolute path to the persisted stats.jsonl. */
  getLogPath() {
    return this._logPath;
  },

  /**
   * W4-1: read the persisted metrics log from disk (post-restart
   * replay). Skips malformed lines, returns [] if missing.
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
        process.stderr.write(`[metrics] malformed line skipped: ${line.slice(0, 80)}\n`);
      }
    }
    return out;
  },

  // Internal: record a single event, update counters, persist.
  _record(topic, payload) {
    if (!this._recording) {
      return;
    }
    const durationMs =
      payload && typeof payload.duration_ms === 'number'
        ? payload.duration_ms
        : null;
    this._eventsByTopic[topic] = (this._eventsByTopic[topic] || 0) + 1;
    this._totalEvents += 1;
    if (durationMs !== null) {
      this._durationSumByTopic[topic] =
        (this._durationSumByTopic[topic] || 0) + durationMs;
      this._durationCountByTopic[topic] =
        (this._durationCountByTopic[topic] || 0) + 1;
      this._totalDurationSum += durationMs;
      this._totalDurationCount += 1;
    }
    this._lastEventAt = new Date().toISOString();
    // P2j-pattern: append a record to disk.
    const entry = {
      topic,
      duration_ms: durationMs,
      recordedAt: this._lastEventAt,
    };
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      fs.appendFileSync(this._logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[metrics] persist failed: ${err.message}\n`);
    }
  },
};
