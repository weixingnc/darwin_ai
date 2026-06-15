/**
 * DeepSeek provider — OpenAI-compatible wire format (V3_ROADMAP P1).
 *
 * DeepSeek's public API (`https://api.deepseek.com`) is wire-compatible with
 * OpenAI's `/v1/chat/completions` endpoint, so this provider REUSES the
 * OpenAI-compatible protocol layer (`provider/protocol/openai-compatible.js`)
 * to avoid the A-3 anti-pattern of double-impl (v0.25 飞书 bug root cause).
 *
 * v2 surface (parallels `openai-compatible.js`):
 *   - chat(messages, options): real HTTP POST → `/v1/chat/completions`
 *   - listModels(): static catalogue (no /v1/models endpoint in DeepSeek public API)
 *   - embed(): NOT_IMPLEMENTED (Darwin self-impl)
 *   - stream(): out of scope for P1-B1 (P1-B2+)
 *
 * DeepSeek R1 reasoning surface (V3 thinking mode):
 *   - Response payload for `deepseek-reasoner` includes a top-level
 *     `reasoning_content` field on `choices[0].message` containing the chain
 *     of thought. We surface it as `usage.reasoning` (string) AND preserve it
 *     under `raw.choices[0].message.reasoning_content` for callers that want
 *     the original wire shape.
 *   - For V3 (non-reasoner) `deepseek-chat`, `reasoning_content` is null/empty.
 *     Surface still present (empty string) so downstream code is uniform.
 *
 * A-3 lesson: protocol logic is delegated to `createOpenAICompatibleProtocol`
 *   (no second copy of `buildRequest` / `parseResponse` here).
 * A-4 lesson: config via ConfigResolver.get('provider-deepseek'), never
 *   process.env reads.
 *
 * LLM gate (ADR-009): provider chat() invokes LLM (network call) — this is
 *   the ONLY LLM-bearing step in this module. Mechanical code only otherwise.
 */

import { ProviderBase } from './base.js';
import { createOpenAICompatibleProtocol } from './protocol/openai-compatible.js';
import { ConfigResolver } from '../core/config-resolver.js';

const NOT_IMPLEMENTED_MSG = '[deepseek] NOT_IMPLEMENTED';
const CHAT_PATH = '/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60000;
// DeepSeek public catalogue (V3 + R1). Darwin self-evolves this list over time.
const STATIC_MODELS = Object.freeze([
  'deepseek-chat', // V3 (default)
  'deepseek-reasoner', // R1 (reasoning)
]);

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return '';
  }
  let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  // Allow user to pass either `https://api.deepseek.com/v1` or the bare base.
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
  const err = new Error(`[deepseek] HTTP ${status}: ${msg}`);
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
 * Extract DeepSeek R1 reasoning_content from a parsed raw response.
 * Returns '' when the field is absent (V3 / non-reasoning models).
 * Defensive: never throws (v1 #4 try/catch lesson).
 */
function extractReasoning(raw) {
  try {
    if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) {
      return '';
    }
    const m = raw.choices[0] && raw.choices[0].message;
    if (!m || typeof m !== 'object' || typeof m.reasoning_content !== 'string') {
      return '';
    }
    return m.reasoning_content;
  } catch {
    return '';
  }
}

/**
 * DeepSeekProvider: OpenAI-compatible LLM provider for DeepSeek.
 *
 * Constructor opts: baseUrl, apiKey, defaultModel, eventBus (req), protocol?, timeoutMs?
 */
export class DeepSeekProvider extends ProviderBase {
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[deepseek] constructor: opts.eventBus is required');
    }
    super({
      name: 'deepseek',
      capabilities: ['chat', 'tool-call', 'list-models'],
      eventBus: opts.eventBus,
    });
    this._baseUrl = normalizeBaseUrl(opts.baseUrl);
    this._apiKey = opts.apiKey || '';
    this._defaultModel = opts.defaultModel || 'deepseek-chat';
    this._timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    // A-3: REUSE the OpenAI protocol — DeepSeek is wire-compatible.
    this._protocol = opts.protocol || createOpenAICompatibleProtocol({ eventBus: opts.eventBus });
  }

  async _doChat(messages, options = {}) {
    const opts = options || {};
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const bodyEntry = await this._protocol.buildRequest(messages, opts, model);
    if (!bodyEntry.ok) {
      const err = new Error(`[deepseek] buildRequest failed: ${bodyEntry.error.message}`);
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
      const err = new Error(`[deepseek] parseResponse failed: ${parsed.error.message}`);
      err.cause = parsed.error;
      throw err;
    }
    // DeepSeek R1 reasoning surface: extract `reasoning_content` from the first
    // choice's message (V3 thinking mode). Surface as `usage.reasoning` so
    // downstream callers (diagnose / propose / audit) can audit reasoning
    // chains uniformly. Preserve raw for callers that want the original shape.
    const reasoning = extractReasoning(raw);
    return {
      content: parsed.value.content,
      toolCalls: parsed.value.tool_calls,
      usage: { ...(parsed.value.usage || {}), reasoning },
      raw,
    };
  }

  /**
   * DeepSeek does not expose a public `/v1/models` endpoint at the V3 launch
   * date (2026-06-15) — return the static catalogue instead. Darwin can
   * swap this for a live endpoint later if DeepSeek adds one.
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
      throw new TypeError('[deepseek] fromConfig: opts.eventBus is required');
    }
    const resolver = opts.resolver || new ConfigResolver();
    const key = typeof opts.configKey === 'string' ? opts.configKey : 'provider-deepseek';
    const cfg = resolver.get(key) || {};
    return new DeepSeekProvider({
      eventBus: opts.eventBus,
      baseUrl: cfg.base_url || cfg.baseUrl || 'https://api.deepseek.com',
      apiKey: cfg.api_key || cfg.apiKey || '',
      defaultModel: cfg.default_model || cfg.defaultModel || 'deepseek-chat',
      timeoutMs: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
      protocol: opts.protocol,
    });
  }
}
