/**
 * Qwen (Aliyun DashScope) provider — OpenAI-compatible wire format (V3_ROADMAP P1).
 *
 * Aliyun's DashScope provides an "OpenAI-compatible mode" at
 * `https://dashscope.aliyuncs.com/compatible-mode/v1/` that follows the
 * OpenAI chat-completions wire format. We REUSE the OpenAI-compatible
 * protocol layer (`provider/protocol/openai-compatible.js`) to avoid the A-3
 * anti-pattern of double-impl (v0.25 飞书 bug root cause).
 *
 * v2 surface (parallels `openai-compatible.js`):
 *   - chat(messages, options): real HTTP POST → `/compatible-mode/v1/chat/completions`
 *   - listModels(): static catalogue (DashScope compatible-mode lists
 *     qwen-turbo / qwen-plus / qwen-max at P1-B1; Darwin can extend later)
 *   - embed(): NOT_IMPLEMENTED (Qwen has its own embedding endpoint with a
 *     different wire format — Darwin can add a dedicated provider later)
 *   - stream(): out of scope for P1-B1 (P1-B2+)
 *
 * A-3 lesson: protocol logic is delegated to `createOpenAICompatibleProtocol`
 *   (no second copy of `buildRequest` / `parseResponse` here).
 * A-4 lesson: config via ConfigResolver.get('provider-qwen'), never
 *   process.env reads.
 *
 * LLM gate (ADR-009): provider chat() invokes LLM (network call) — this is
 *   the ONLY LLM-bearing step in this module. Mechanical code only otherwise.
 *
 * Note: DashScope's "compatible-mode" was DESIGNED for OpenAI drop-in
 * compatibility, so all OpenAI-isms (tool_calls, role:tool, finish_reason)
 * work identically. We do NOT special-case any Qwen-specific field.
 */

import { ProviderBase } from './base.js';
import { createOpenAICompatibleProtocol } from './protocol/openai-compatible.js';
import { ConfigResolver } from '../core/config-resolver.js';

const NOT_IMPLEMENTED_MSG = '[qwen] NOT_IMPLEMENTED';
const CHAT_PATH = '/compatible-mode/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60000;
// DashScope OpenAI-compatible-mode catalogue (2026-06-15). Darwin self-evolves
// this list over time as Qwen releases new models.
const STATIC_MODELS = Object.freeze([
  'qwen-turbo', // default
  'qwen-plus',
  'qwen-max',
]);

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return '';
  }
  let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  // Allow user to pass either `https://dashscope.aliyuncs.com/compatible-mode/v1`
  // OR the bare base `https://dashscope.aliyuncs.com`. We then append the
  // CHAT_PATH which already includes `/compatible-mode/v1/...`.
  // Strip both `/v1` and `/compatible-mode/v1` to be lenient about user input.
  url = url.replace(/\/compatible-mode\/v1$/, '');
  url = url.replace(/\/v1$/, '');
  return url;
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
  const err = new Error(`[qwen] HTTP ${status}: ${msg}`);
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
 * QwenProvider: OpenAI-compatible LLM provider for Aliyun DashScope.
 *
 * Constructor opts: baseUrl, apiKey, defaultModel, eventBus (req), protocol?, timeoutMs?
 */
export class QwenProvider extends ProviderBase {
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[qwen] constructor: opts.eventBus is required');
    }
    super({
      name: 'qwen',
      capabilities: ['chat', 'tool-call', 'list-models'],
      eventBus: opts.eventBus,
    });
    this._baseUrl = normalizeBaseUrl(opts.baseUrl);
    this._apiKey = opts.apiKey || '';
    this._defaultModel = opts.defaultModel || 'qwen-turbo';
    this._timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    // A-3: REUSE the OpenAI protocol — DashScope compatible-mode is wire-compatible.
    this._protocol = opts.protocol || createOpenAICompatibleProtocol({ eventBus: opts.eventBus });
  }

  async _doChat(messages, options = {}) {
    const opts = options || {};
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const bodyEntry = await this._protocol.buildRequest(messages, opts, model);
    if (!bodyEntry.ok) {
      const err = new Error(`[qwen] buildRequest failed: ${bodyEntry.error.message}`);
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
      const err = new Error(`[qwen] parseResponse failed: ${parsed.error.message}`);
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

  /**
   * DashScope OpenAI-compatible-mode does have `/v1/models` but the response
   * is paginated and model-id format differs from openai. Return a static
   * catalogue (matches `anthropic.js` pattern) for P1-B1. Darwin can swap
   * for a live fetch later.
   */
  async _doListModels() {
    return [...STATIC_MODELS];
  }

  async _doEmbed(_t) {
    throw new Error(NOT_IMPLEMENTED_MSG);
  }

  /**
   * Build a provider from ConfigResolver config. A-4 lesson: ConfigResolver
   * handles `${VAR}` expansion; never read process.env directly.
   */
  static fromConfig(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[qwen] fromConfig: opts.eventBus is required');
    }
    const resolver = opts.resolver || new ConfigResolver();
    const key = typeof opts.configKey === 'string' ? opts.configKey : 'provider-qwen';
    const cfg = resolver.get(key) || {};
    return new QwenProvider({
      eventBus: opts.eventBus,
      baseUrl: cfg.base_url || cfg.baseUrl || 'https://dashscope.aliyuncs.com',
      apiKey: cfg.api_key || cfg.apiKey || '',
      defaultModel: cfg.default_model || cfg.defaultModel || 'qwen-turbo',
      timeoutMs: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
      protocol: opts.protocol,
    });
  }
}
