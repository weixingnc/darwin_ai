/**
 * cron-audit — Darwin CRON scheduler → evolution:audit heartbeat plugin.
 *
 *   V7 cycle 2 (2026-06-19): P2-ext 调度面升级. Subscribes to
 *     lifecycle/cron.js's `cron:tick` event and emits an
 *     `evolution:audit` event with a heartbeat payload
 *     ({ts, source: 'cron-audit', proposal_id, action: 'heartbeat',
 *      outcome: 'info'}). The audit event is then forwarded by
 *     plugin/feishu-notify as a Feishu interactive card to the
 *     configured target — completing the cron → audit → card chain.
 *
 * The chain in production:
 *   setInterval tick → cron:tick → cron-audit._onCronTick
 *     → bus.emit('evolution:audit', {...})
 *     → plugin/feishu-notify subscribes → builds card
 *     → platform/feishu send → Feishu DM (interactive card).
 *
 * Manifest (P2d contract, validated by IPlugin.validate at load time):
 *   - name         'cron-audit'        (lowercase, non-empty)
 *   - version      '0.1.0'             (V7 cycle 2 initial release)
 *   - capabilities ['tool']            (PLUGIN_CAPABILITIES whitelist;
 *                                       same as feishu-notify — both
 *                                       react to bus events.)
 *   - permissions  ['bus:on', 'bus:off', 'log:info', 'log:error',
 *                   'config:get']
 *
 * Lifecycle:
 *   init(ctx)   bind bus, resolve cron-audit config from
 *               ConfigResolver.get('plugin-cron-audit') →
 *               { intervalMs?: 60000, enabled?: true, source?: 'cron-audit' }
 *               Subscribe to cron:tick (via ctx.eventBus.on).
 *               If ctx.adapters?.cron is present, this plugin owns the
 *               cron lifecycle: cron.register('cron-audit', intervalMs,
 *               this._heartbeat) + cron.start() on init(), and
 *               cron.unregister('cron-audit') on destroy().
 *               In production (Darwin bootstrap), ctx.adapters?.cron is
 *               undefined — the cron service is already created by
 *               lifecycle/bootstrap.js's cron phase and another driver
 *               (e.g. an admin CLI) registers jobs there. The plugin
 *               only listens to cron:tick events in that case.
 *
 *   destroy()   unsubscribe cron:tick, unregister cron job (if owned),
 *               clear state.
 *
 * A-5 isolation: try/catch + stderr log, NEVER throw across module
 * boundary.
 *
 * LLM gate (ADR-009): mechanical — emits a fixed payload. No LLM call.
 * Process.env (A-4): config via ConfigResolver only.
 * Network: never touches fetch — emits events on the bus and that's it.
 */

const CRON_TICK = 'cron:tick';
const EVOLUTION_AUDIT = 'evolution:audit';

function resolveAuditConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    intervalMs: Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : 60000,
    enabled: cfg.enabled === false ? false : true,
    source: typeof cfg.source === 'string' ? cfg.source : 'cron-audit',
  };
}

function makeProposalId(ts, source) {
  return `heartbeat-${source}-${ts}`;
}

export default {
  name: 'cron-audit',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'bus:off', 'log:info', 'log:error', 'config:get'],

  init(ctx) {
    this._bus = (ctx && ctx.eventBus) || null;
    this._cfg = resolveAuditConfig(ctx && ctx.config);
    this._cron = (ctx && ctx.adapters && ctx.adapters.cron) || null;
    this._ownsCron = Boolean(this._cron);
    this._handler = (payload) => this._onCronTick(payload);

    if (this._cron) {
      // Test seam / standalone use: plugin owns the cron lifecycle.
      // cron.tick(name) will call our handler directly — do NOT also
      // subscribe to cron:tick, otherwise we'd double-fire (the cron
      // service already emits cron:tick BEFORE calling the handler).
      try {
        this._cron.register('cron-audit', this._cfg.intervalMs, (payload) =>
          this._onCronTick(payload),
        );
        this._cron.start();
      } catch (err) {
        const msg = err && err.message ? err.message : 'cron init failed';
        process.stderr.write(`[cron-audit] init failed: ${msg}\n`);
      }
    } else if (this._bus) {
      // Production default: bootstrap's cron service emits cron:tick,
      // we subscribe here. No direct cron reference.
      this._bus.on(CRON_TICK, this._handler);
    }
  },

  enable() {
    if (this._cfg) {
      this._cfg.enabled = true;
    }
  },

  disable() {
    if (this._cfg) {
      this._cfg.enabled = false;
    }
  },

  destroy() {
    if (this._bus && this._handler) {
      this._bus.off(CRON_TICK, this._handler);
    }
    if (this._cron && this._ownsCron) {
      try {
        this._cron.unregister('cron-audit');
      } catch {
        /* swallow — A-5 */
      }
    }
    this._handler = null;
    this._bus = null;
    this._cron = null;
    this._ownsCron = false;
    this._cfg = { intervalMs: 60000, enabled: true, source: 'cron-audit' };
  },

  /**
   * Internal: handle a cron:tick event. Emits evolution:audit with a
   * heartbeat payload. Errors are logged, never thrown across the
   * module boundary (A-5).
   */
  async _onCronTick(payload) {
    if (!this._cfg || this._cfg.enabled === false) {
      return;
    }
    if (!this._bus) {
      return;
    }
    const ts = payload && typeof payload.ts === 'number' ? payload.ts : Date.now();
    const auditPayload = {
      ts,
      source: this._cfg.source,
      proposal_id: makeProposalId(ts, this._cfg.source),
      action: 'heartbeat',
      outcome: 'info',
    };
    try {
      this._bus.emit(EVOLUTION_AUDIT, auditPayload);
    } catch (err) {
      const msg = err && err.message ? err.message : 'emit failed';
      process.stderr.write(`[cron-audit] evolution:audit emit failed: ${msg}\n`);
    }
  },

  /** Test helper: return the resolved audit config. */
  _getAuditConfig() {
    return { ...this._cfg };
  },
};
