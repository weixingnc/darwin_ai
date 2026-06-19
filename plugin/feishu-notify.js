/**
 * feishu-notify — Darwin self-evolution → Feishu DM push plugin (V6 cycle 1).
 *
 * Subscribes to evolution:apply:after + evolution:audit events. When they
 * fire, formats a short status message ("✅ Darwin cycle 收口: …") and
 * pushes it to a configured Feishu open_id via the feishu adapter's
 * `send` action (V5.1 real IM v1 wire).
 *
 * V6.1 use case: Darwin's self-evolution completes a cycle (apply +
 * audit), the user gets a Feishu DM without having to tail a log file.
 *
 * Manifest (P2d contract, validated by IPlugin.validate at load time):
 *   - name         'feishu-notify'     (lowercase, non-empty)
 *   - version      '0.1.0'             (V6 cycle 1, initial release)
 *   - capabilities ['tool']            (PLUGIN_CAPABILITIES; same as audit.
 *                                       Note: PM brief said ['bus', 'platform']
 *                                       but PLUGIN_CAPABILITIES whitelist is
 *                                       ['tool','skill','memory','hook','listener']
 *                                       — `bus` and `platform` are NOT valid;
 *                                       we use `tool` which is semantically
 *                                       closest. Documented as V6.1 decision.)
 *   - permissions  ['bus:on', 'bus:off', 'log:info', 'log:error',
 *                   'config:get']
 *                                       (bus:off for destroy() to unsubscribe;
 *                                        log:error for error isolation path;
 *                                        config:get for ConfigResolver.get;
 *                                        NOT 'network:raw' — the feishu
 *                                        adapter handles fetch via injected
 *                                        fetchImpl, plugin never touches
 *                                        fetch directly.)
 *
 * Lifecycle:
 *   init(ctx)   bind bus, resolve feishu target from
 *               ConfigResolver.get('plugin-feishu-notify') →
 *               { target?: 'ou_xxx', enabled?: boolean }
 *               If config is empty, target stays empty and the plugin
 *               no-ops on every event (graceful degradation — Darwin
 *               can boot without a Feishu target configured).
 *               ctx.adapters?.feishu may override the imported feishu
 *               adapter (for tests). Default: import feishu from
 *               ../platform/feishu.js (real IM v1 wire).
 *               Subscribe to evolution:apply:after + evolution:audit.
 *   destroy()   unsubscribe both topics, clear state.
 *
 * Adapter injection contract (for tests):
 *   plugin.init({ eventBus, config, adapters: { feishu: stubAdapter } })
 *   The stub must implement execute({action, payload, config}) → Promise.
 *   For 'send' action, payload must include { receive_id, text } and
 *   config may include { resolver, fetchImpl } for full test isolation.
 */

import { feishu as defaultFeishu } from '../platform/feishu.js';

const EVOLUTION_APPLY_AFTER = 'evolution:apply:after';
const EVOLUTION_AUDIT = 'evolution:audit';

function resolveNotifyConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    target: typeof cfg.target === 'string' ? cfg.target : '',
    enabled: cfg.enabled === false ? false : true,
  };
}

function formatApplyAfter(payload) {
  const subject =
    (payload && typeof payload.subject === 'string' && payload.subject) ||
    (payload && typeof payload.tag === 'string' && payload.tag) ||
    'unknown apply';
  return `✅ Darwin cycle 收口: ${subject}`;
}

function formatAudit(payload) {
  const proposal =
    (payload && typeof payload.proposal_id === 'string' && payload.proposal_id) || 'unknown';
  const action = (payload && typeof payload.action === 'string' && payload.action) || '?';
  const outcome = (payload && typeof payload.outcome === 'string' && payload.outcome) || '?';
  return `📒 Darwin audit: ${proposal} (${action}/${outcome})`;
}

async function dispatch(adapter, { target, text }) {
  if (typeof adapter !== 'object' || typeof adapter.execute !== 'function') {
    return { ok: false, error: 'feishu adapter not available' };
  }
  if (!target || target.length === 0) {
    return { ok: false, error: 'no feishuNotifyTarget configured' };
  }
  let r;
  try {
    r = await adapter.execute({
      action: 'send',
      payload: { receive_id: target, text },
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'feishu execute threw' };
  }
  return r && typeof r === 'object' ? r : { ok: false, error: 'feishu returned no result' };
}

export default {
  name: 'feishu-notify',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'bus:off', 'log:info', 'log:error', 'config:get'],

  init(ctx) {
    this._bus = (ctx && ctx.eventBus) || null;
    // Allow test override of the feishu adapter (so unit tests don't
    // touch platform/feishu.js). Default: imported real adapter.
    this._adapter = (ctx && ctx.adapters && ctx.adapters.feishu) || defaultFeishu;
    this._notify = resolveNotifyConfig(ctx && ctx.config);
    this._handlers = {
      [EVOLUTION_APPLY_AFTER]: (payload) => this._onEvolutionEvent(EVOLUTION_APPLY_AFTER, payload),
      [EVOLUTION_AUDIT]: (payload) => this._onEvolutionEvent(EVOLUTION_AUDIT, payload),
    };
    if (this._bus) {
      for (const [topic, fn] of Object.entries(this._handlers)) {
        this._bus.on(topic, fn);
      }
    }
  },

  enable() {
    if (this._notify) {
      this._notify.enabled = true;
    }
  },

  disable() {
    if (this._notify) {
      this._notify.enabled = false;
    }
  },

  destroy() {
    if (this._bus && this._handlers) {
      for (const [topic, fn] of Object.entries(this._handlers)) {
        this._bus.off(topic, fn);
      }
    }
    this._handlers = null;
    this._bus = null;
    this._adapter = null;
    this._notify = { target: '', enabled: true };
  },

  /**
   * Internal: handle an evolution event. Builds a short status text and
   * dispatches it to feishu via the adapter. Errors are logged, never
   * thrown across the module boundary (A-5 anti-patterns).
   */
  async _onEvolutionEvent(topic, payload) {
    if (!this._notify || this._notify.enabled === false) {
      return;
    }
    const text = topic === EVOLUTION_AUDIT ? formatAudit(payload) : formatApplyAfter(payload);
    const r = await dispatch(this._adapter, { target: this._notify.target, text });
    if (r && r.ok === true) {
      return;
    }
    const reason = r && r.error ? r.error : 'unknown';
    process.stderr.write(`[feishu-notify] ${topic} push failed: ${reason}\n`);
  },

  /** Test helper: return the resolved notify config (target + enabled). */
  _getNotifyConfig() {
    return { ...this._notify };
  },
};
