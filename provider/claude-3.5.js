/** claude-3.5 provider — PR V3+ P1 (cycle 10, claude-3.5 closure).
 *  Parallel to anthropic.js: same Anthropic Messages API wire format, but a
 *  distinct provider name + capability set (3.5-only: vision, computer-use,
 *  prompt-cache). A-3 严守: reuses createAnthropicProtocol +
 *  createAnthropicProtocolStream — NO double-impl of buildRequest/parseResponse.
 *  A-4 ConfigResolver-only (no process.env). A-5 EventBus-only error path.
 *  LLM gate (ADR-009): chat() only. */

import { randomUUID } from 'node:crypto';
import { ProviderBase } from './base.js';
import { createAnthropicProtocol } from './anthropic-protocol.js';
import { createAnthropicProtocolStream } from './anthropic-protocol-stream.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { EVENTS } from '../core/events.js';

const VERSION = '1.0.0';
const CHAT_PATH = '/v1/messages';
const DEFAULT_TIMEOUT_MS = 60000;
const NOT_IMPLEMENTED_MSG = '[claude-3.5] NOT_IMPLEMENTED';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const STATIC_MODELS = Object.freeze(['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']);

const strip = (u) => (typeof u === 'string' && u.endsWith('/') ? u.slice(0, -1) : u || '');
const headers = (k, o) => ({
  'Content-Type': 'application/json',
  'x-api-key': k || '',
  'anthropic-version': '2023-06-01',
  ...(o && o.beta ? { 'anthropic-beta': o.beta } : {}),
});
const errMsg = (raw, s) => {
  try {
    if (raw && typeof raw === 'object') {
      const e = raw.error;
      if (e && e.message) {return String(e.message);}
      if (typeof e === 'string') {return e;}
      if (raw.message) {return String(raw.message);}
    }
  } catch { /* */ }
  return `HTTP ${s}`;
};
const httpErr = (raw, s) => Object.assign(new Error(`[claude-3.5] HTTP ${s}: ${errMsg(raw, s)}`), { status: s, raw });
const doPost = (url, body, k, opts, ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { method: 'POST', headers: headers(k, opts), body: JSON.stringify(body), signal: c.signal }).finally(() => clearTimeout(t));
};

export class Claude35Provider extends ProviderBase {
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {throw new TypeError('[claude-3.5] constructor: opts.eventBus is required');}
    super({
      name: 'claude-3.5',
      // 3.5-only capabilities: vision, computer-use, prompt-cache.
      capabilities: ['chat', 'stream', 'tool-call', 'vision', 'computer-use', 'prompt-cache', 'listModels'],
      eventBus: opts.eventBus,
    });
    this.version = VERSION;
    this._baseUrl = strip(opts.baseUrl) || DEFAULT_BASE_URL;
    this._apiKey = opts.apiKey || '';
    this._defaultModel = opts.defaultModel || STATIC_MODELS[0];
    this._timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._protocol = opts.protocol || createAnthropicProtocol({ eventBus: opts.eventBus });
    this._streamProtocol = opts.streamProtocol || createAnthropicProtocolStream({ eventBus: opts.eventBus });
  }

  /** Per-spec init entry: wires eventBus + config without touching the registry. */
  init({ eventBus, config, container: _c } = {}) {
    if (!eventBus) {throw new TypeError('[claude-3.5] init: eventBus is required');}
    const cfg = config && typeof config === 'object' ? config : {};
    this._bus = eventBus;
    this._baseUrl = strip(cfg.base_url || cfg.baseUrl || '') || DEFAULT_BASE_URL;
    this._apiKey = cfg.api_key || cfg.apiKey || '';
    this._defaultModel = cfg.default_model || cfg.defaultModel || STATIC_MODELS[0];
    if (typeof cfg.timeout_ms === 'number') {this._timeoutMs = cfg.timeout_ms;}
    this._protocol = createAnthropicProtocol({ eventBus });
    this._streamProtocol = createAnthropicProtocolStream({ eventBus });
    return this;
  }

  async _doChat(messages, options = {}) {
    const opts = options || {};
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const be = await this._protocol.buildRequest(messages, opts, model);
    if (!be.ok) {throw new Error(`buildRequest failed: ${be.error.message}`);}
    const res = await doPost(`${this._baseUrl}${CHAT_PATH}`, be.value, this._apiKey, opts, this._timeoutMs);
    const raw = await res.json();
    if (!res.ok) {throw httpErr(raw, res.status);}
    const parsed = await this._protocol.parseResponse(raw);
    if (!parsed.ok) {throw new Error(`parseResponse failed: ${parsed.error.message}`);}
    return { content: parsed.value.content, toolCalls: parsed.value.tool_calls, usage: parsed.value.usage, raw };
  }

  async *stream(messages, options = {}) {
    const opts = options || {};
    const ctx = { provider: this.name, phase: 'stream', traceId: randomUUID() };
    this._bus.emit(EVENTS.PROVIDER_CALL_BEFORE, ctx);
    let n = 0;
    try {
      const res = await this._openStreamResponse(messages, opts);
      for await (const ev of this._streamProtocol.parseStream(res, { timeoutMs: this._timeoutMs })) {
        if (ev && ev.type !== 'done' && ev.type !== 'error') {n++;}
        yield ev;
      }
      this._bus.emit(EVENTS.PROVIDER_CALL_AFTER, { ...ctx, count: n });
    } catch (err) {
      const ne = { message: (err && err.message) || String(err), name: err && err.name, status: err && err.status };
      this._bus.emit(EVENTS.PROVIDER_CALL_ERROR, { ...ctx, error: ne });
      yield { type: 'error', error: ne };
    }
  }

  async _openStreamResponse(messages, opts) {
    const proto = this._streamProtocol;
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const be = await proto.buildStreamRequest(messages, opts, model);
    if (!be.ok) {throw new Error(`buildStreamRequest failed: ${be.error.message}`);}
    const res = await doPost(`${this._baseUrl}${CHAT_PATH}`, be.value, this._apiKey, opts, this._timeoutMs);
    if (res.ok) {return res;}
    let body = '';
    try { body = await res.text(); } catch { /* noop */ }
    const e = new Error(`stream HTTP ${res.status}: ${body || 'no body'}`);
    e.status = res.status;
    throw e;
  }

  async _doListModels() { return [...STATIC_MODELS]; }
  async _doEmbed(_t) { throw new Error(NOT_IMPLEMENTED_MSG); }

  /** Build a provider from ConfigResolver config (A-4 lesson: ${VAR} expansion). */
  static fromConfig(opts = {}) {
    if (!opts || !opts.eventBus) {throw new TypeError('[claude-3.5] fromConfig: opts.eventBus is required');}
    const resolver = opts.resolver || new ConfigResolver();
    const key = typeof opts.configKey === 'string' ? opts.configKey : 'provider-claude-3.5';
    const cfg = resolver.get(key) || {};
    return new Claude35Provider({
      eventBus: opts.eventBus,
      baseUrl: cfg.base_url || cfg.baseUrl || DEFAULT_BASE_URL,
      apiKey: cfg.api_key || cfg.apiKey || '',
      defaultModel: cfg.default_model || cfg.defaultModel || STATIC_MODELS[0],
      timeoutMs: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
      protocol: opts.protocol,
      streamProtocol: opts.streamProtocol,
    });
  }
}

export function createClaude35Provider(opts) {
  return new Claude35Provider(opts);
}
export default createClaude35Provider;
