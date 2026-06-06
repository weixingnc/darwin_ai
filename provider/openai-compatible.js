/**
 * OpenAI-compatible provider — wires the OpenAI-compatible protocol layers
 * (PR 8 non-streaming + PR 10 streaming) into ProviderBase (PR 6) via real
 * HTTP calls. v2 design: one provider covers 9/10 国产 LLM (A-3 lesson).
 * Config via ConfigResolver.get('provider-openai') — never process.env (A-4).
 * chat()/listModels() wrapped by ProviderBase in ErrorHandler + BEFORE/AFTER/
 * ERROR. stream() (PR 10) returns an async iterable of accumulated chunks
 * and manually emits the same events (base _wrap resolves to a single entry,
 * not a generator). embed() is a stub — Darwin self-impl.
 */

import { randomUUID } from 'node:crypto';
import { ProviderBase } from './base.js';
import { createOpenAICompatibleProtocol } from './protocol/openai-compatible.js';
import { OpenAICompatibleStreamProtocol } from './protocol/openai-compatible-stream.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { EVENTS } from '../core/events.js';

const NOT_IMPLEMENTED_MSG = '[openai-compatible] NOT_IMPLEMENTED';
const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const DEFAULT_TIMEOUT_MS = 30000;

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return '';
  }
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  };
}

function extractErrorMessage(rawBody, status) {
  try {
    if (rawBody && typeof rawBody === 'object') {
      if (rawBody.error && typeof rawBody.error === 'object' && rawBody.error.message) {
        return String(rawBody.error.message);
      }
      if (rawBody.error && typeof rawBody.error === 'string') {
        return rawBody.error;
      }
      if (rawBody.message) {
        return String(rawBody.message);
      }
    }
  } catch {
    /* fall through */
  }
  return `HTTP ${status}`;
}

function wrapHttpError(raw, status) {
  const msg = extractErrorMessage(raw, status);
  const err = new Error(`[openai-compatible] HTTP ${status}: ${msg}`);
  err.status = status;
  err.raw = raw;
  return err;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAICompatibleProvider: wires protocol layer to HTTP fetch().
 * Constructor opts: baseUrl, apiKey, defaultModel, eventBus (req), protocol?, timeoutMs?
 */
export class OpenAICompatibleProvider extends ProviderBase {
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[openai-compatible] constructor: opts.eventBus is required');
    }
    super({
      name: 'openai-compatible',
      capabilities: ['chat', 'tool-call', 'stream', 'embed', 'list-models'],
      eventBus: opts.eventBus,
    });
    this._baseUrl = normalizeBaseUrl(opts.baseUrl);
    this._apiKey = opts.apiKey || '';
    this._defaultModel = opts.defaultModel || '';
    this._timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._protocol =
      opts.protocol || createOpenAICompatibleProtocol({ eventBus: opts.eventBus });
    this._streamProtocol =
      opts.streamProtocol || new OpenAICompatibleStreamProtocol({ eventBus: opts.eventBus });
  }

  async _doChat(messages, options = {}) {
    const opts = options || {};
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const bodyEntry = await this._protocol.buildRequest(messages, opts, model);
    if (!bodyEntry.ok) {
      const err = new Error(`[openai-compatible] buildRequest failed: ${bodyEntry.error.message}`);
      err.cause = bodyEntry.error;
      throw err;
    }
    const res = await fetchWithTimeout(
      `${this._baseUrl}${CHAT_PATH}`,
      {
        method: 'POST',
        headers: buildHeaders(this._apiKey),
        body: JSON.stringify(bodyEntry.value),
      },
      this._timeoutMs,
    );
    const raw = await res.json();
    if (!res.ok) {
      throw wrapHttpError(raw, res.status);
    }
    const parsed = await this._protocol.parseResponse(raw);
    if (!parsed.ok) {
      const err = new Error(`[openai-compatible] parseResponse failed: ${parsed.error.message}`);
      err.cause = parsed.error;
      throw err;
    }
    return {
      content: parsed.value.content,
      toolCalls: parsed.value.tool_calls,
      usage: parsed.value.usage,
      raw,
    };
  }

  async _doListModels() {
    const res = await fetchWithTimeout(
      `${this._baseUrl}${MODELS_PATH}`,
      { method: 'GET', headers: buildHeaders(this._apiKey) },
      this._timeoutMs,
    );
    const raw = await res.json();
    if (!res.ok) {
      throw wrapHttpError(raw, res.status);
    }
    if (!raw || !Array.isArray(raw.data)) {
      throw new Error('[openai-compatible] listModels: response.data is not an array');
    }
    const ids = [];
    for (const item of raw.data) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        ids.push(item.id);
      }
    }
    return ids;
  }

  /**
   * Streaming entry: PR 10. Returns an async iterable of accumulated chunks.
   * Emits PROVIDER_CALL_BEFORE synchronously, then PROVIDER_CALL_AFTER on
   * successful drain or PROVIDER_CALL_ERROR on failure (which also yields
   * {type:'error', error} as the first event). Manual emission is required
   * because ProviderBase._wrap resolves to a single entry, not a generator.
   */
  async *stream(messages, options = {}) {
    const opts = options || {};
    const ctx = { provider: this.name, phase: 'stream', traceId: randomUUID() };
    this._bus.emit(EVENTS.PROVIDER_CALL_BEFORE, ctx);
    let chunkCount = 0;
    try {
      const res = await this._openStreamResponse(messages, opts);
      for await (const ev of this._streamProtocol.parseStream(res, { timeoutMs: this._timeoutMs })) {
        if (ev && ev.type !== 'done') { chunkCount++; }
        yield ev;
      }
      this._bus.emit(EVENTS.PROVIDER_CALL_AFTER, { ...ctx, count: chunkCount });
    } catch (err) {
      const norm = { message: (err && err.message) || String(err), name: err && err.name, status: err && err.status };
      this._bus.emit(EVENTS.PROVIDER_CALL_ERROR, { ...ctx, error: norm });
      yield { type: 'error', error: norm };
    }
  }

  /** PR 10 helper: build stream request + POST + return response. Throws on HTTP error. */
  async _openStreamResponse(messages, opts) {
    const proto = this._streamProtocol;
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const bodyEntry = await proto.buildStreamRequest(messages, opts, model);
    if (!bodyEntry.ok) {
      throw new Error(`[openai-compatible] buildStreamRequest failed: ${bodyEntry.error.message}`);
    }
    const res = await fetchWithTimeout(`${this._baseUrl}${CHAT_PATH}`, {
      method: 'POST', headers: buildHeaders(this._apiKey), body: JSON.stringify(bodyEntry.value),
    }, this._timeoutMs);
    if (res.ok) { return res; }
    let body = '';
    try { body = await res.text(); } catch { /* noop */ }
    const err = new Error(`[openai-compatible] stream HTTP ${res.status}: ${body || 'no body'}`);
    err.status = res.status;
    throw err;
  }

  async _doEmbed(_t) {
    throw new Error(NOT_IMPLEMENTED_MSG);
  }

  /**
   * Build a provider from ConfigResolver config. Reads `provider-openai`
   * module unless `configKey` overrides. ConfigResolver handles ${VAR}
   * expansion (A-4 lesson).
   */
  static fromConfig(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[openai-compatible] fromConfig: opts.eventBus is required');
    }
    const resolver = opts.resolver || new ConfigResolver();
    const key = typeof opts.configKey === 'string' ? opts.configKey : 'provider-openai';
    const cfg = resolver.get(key) || {};
    return new OpenAICompatibleProvider({
      eventBus: opts.eventBus,
      baseUrl: cfg.base_url || cfg.baseUrl || '',
      apiKey: cfg.api_key || cfg.apiKey || '',
      defaultModel: cfg.default_model || cfg.defaultModel || '',
      timeoutMs: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
      protocol: opts.protocol,
    });
  }
}
