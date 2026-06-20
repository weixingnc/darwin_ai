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
 * V8 cycle 1 P1: Qwen R1-style reasoning surface (reasoning_content via
 *   Qwen3 / QwQ models) — parallel to deepseek-reasoner V4 closure.
 *   DashScope OpenAI-compatible-mode exposes `choices[0].message.reasoning_content`
 *   when `enable_thinking=true` (Qwen3 / QwQ models). For V3 (qwen-turbo /
 *   qwen-plus / qwen-max by default), reasoning_content is null. We surface
 *   it as `usage.reasoning` (string | null) AND preserve raw for callers
 *   that want the original wire shape. See extractQwenReasoningContent for
 *   the defensive extraction logic.
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
import {
  normalizeBaseUrl,
  bearerAuthHeader,
  fetchWithTimeout,
  wrapHttpError,
  makeExtractReasoning,
} from './protocol/_shared.js';
import { ConfigResolver } from '../core/config-resolver.js';

const NOT_IMPLEMENTED_MSG = '[qwen] NOT_IMPLEMENTED';
const CHAT_PATH = '/compatible-mode/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60000;
// DashScope OpenAI-compatible-mode catalogue (2026-06-15). Darwin self-evolves
// this list over time as Qwen releases new models.
//   V3 (default) — `qwen-turbo` / `qwen-plus` / `qwen-max`: reasoning_content
//     is null unless `enable_thinking=true` is passed at request time.
//   V8.1 R1-style — `qwen3-max` / `qwq-plus` (Qwen reasoning models): when
//     called with `enable_thinking=true`, response carries a populated
//     `choices[0].message.reasoning_content` field. Not yet listed in
//     STATIC_MODELS — Darwin can self-evolve to extend the catalogue when
//     these models become available (V8.1 is a thin R1-surface parity with
//     deepseek-reasoner V4 closure, not a model rollout).
const extractReasoning = makeExtractReasoning({ onAbsent: null });

const STATIC_MODELS = Object.freeze([
  'qwen-turbo', // default
  'qwen-plus',
  'qwen-max',
]);

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
    this._baseUrl = normalizeBaseUrl(opts.baseUrl, { stripCompatibleMode: true });
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
        headers: bearerAuthHeader(this._apiKey),
        body: JSON.stringify(bodyEntry.value),
      },
      this._timeoutMs,
    );
    const raw = await res.json();
    if (!res.ok) {
      throw wrapHttpError('qwen', raw, res.status);
    }
    const parsed = await this._protocol.parseResponse(raw);
    if (!parsed.ok) {
      const err = new Error(`[qwen] parseResponse failed: ${parsed.error.message}`);
      err.cause = parsed.error;
      throw err;
    }
    // V8.1 R1 reasoning surface: extract `reasoning_content` from the first
    // choice's message (Qwen3 / QwQ with enable_thinking=true). Surface as
    // `usage.reasoning` so downstream callers (diagnose / propose / audit)
    // can audit reasoning chains uniformly. Preserve raw for callers that
    // want the original wire shape. For V3 (qwen-turbo / qwen-plus /
    // qwen-max by default), reasoning_content is null and `usage.reasoning`
    // is null too — explicit surface (not ''), so callers can distinguish
    // "reasoning ran but produced empty text" from "reasoning not invoked".
    const reasoning = extractReasoning(raw);
    return {
      content: parsed.value.content,
      toolCalls: parsed.value.tool_calls,
      usage: { ...(parsed.value.usage || {}), reasoning },
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
