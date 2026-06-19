/**
 * OpenAI-compatible protocol (non-streaming) — PR 8.
 *
 * Covers 9/10 domestic LLM providers (DeepSeek / Qwen / GLM / Moonshot / Kimi)
 * that follow the OpenAI wire format. Streaming is OUT OF SCOPE — PR 9.
 *
 * v1 飞书 bug fixes (ANTI_PATTERNS.md D-1/2/3 + 3 derivatives):
 *  #1 tool_calls format: 1 assistant + N role:tool, NEVER one assistant per toolCall.
 *     Delegates role:tool assembly to PR 7 tool-call.js — NO re-implementation.
 *  #2 tool_call_id: preserved verbatim via buildToolResultMessage.
 *  #3 MAX_TOOL_ROUNDS=5: re-imported from tool-call.js; orchestrator enforces.
 *  #4 try/catch: every method wrapped by ProtocolBase (ErrorHandler.wrapAsync) — never throws.
 *  #5 finish_reason log: console.log on every parseResponse.
 *  #6 stop_reason log: emitted when instance._anthropicMode=true (cross-vendor shim).
 *
 * v2 design: extends ProtocolBase (PR 7). The base class emits
 * PROVIDER_CALL_BEFORE/AFTER/ERROR + ErrorHandler-wrap; we only implement _do* overrides.
 * Every public method returns a Promise<ErrorHandler entry>.
 *
 * Stubs (PR 9 will replace with real SSE parsing): _doParseStreamChunk, _doParseToolCallDelta.
 */

import { ProtocolBase } from './base.js';
import { buildToolResultMessage } from './tool-call.js';

/** v2 plain → OpenAI tools wrapper; pass-through if already OpenAI-shaped. */
function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools.map((t) => {
    if (t && t.type === 'function' && t.function && typeof t.function === 'object') {
      return t;
    }
    return {
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    };
  });
}

/** Build the OpenAI request body. Errors throw; ProtocolBase catches → entry.error. */
function buildRequestBody(messages, options = {}, model = '') {
  const opts = options && typeof options === 'object' ? options : {};
  const body = {
    model: String(model || ''),
    messages: Array.isArray(messages) ? messages : [],
    stream: false,
  };
  if (typeof opts.temperature === 'number') {
    body.temperature = opts.temperature;
  }
  if (typeof opts.max_tokens === 'number') {
    body.max_tokens = opts.max_tokens;
  }
  const tools = toOpenAITools(opts.tools);
  if (tools !== undefined) {
    body.tools = tools;
  }
  if (opts.tool_choice !== undefined && opts.tool_choice !== null) {
    body.tool_choice = opts.tool_choice;
  }
  return body;
}

/** Parse an OpenAI chat-completions response into v2 unified shape. Throws on malformed input. */
function parseResponseBody(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new TypeError('[openai-compatible] parseResponse: rawResponse must be object');
  }
  if (!Array.isArray(rawResponse.choices) || rawResponse.choices.length === 0) {
    throw new Error('[openai-compatible] parseResponse: rawResponse.choices is empty or missing');
  }
  const choice = rawResponse.choices[0] || {};
  const message = choice.message || {};
  return {
    content: message.content === null || message.content === undefined ? '' : message.content,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: rawResponse.usage && typeof rawResponse.usage === 'object' ? rawResponse.usage : {},
    finish_reason:
      choice.finish_reason === null || choice.finish_reason === undefined
        ? 'unknown'
        : choice.finish_reason,
  };
}

/** Emit finish_reason / stop_reason log per v1 fix #5/#6. Never throws. */
function logFinishOrStop(finishReason, opts = {}) {
  try {
    const r =
      finishReason === null || finishReason === undefined ? 'unknown' : String(finishReason);
    const tag = opts && opts.anthropic ? 'stop_reason' : 'finish_reason';
    console.log(`[openai-compatible] ${tag}=${r}`);
  } catch {
    /* never throw */
  }
}

/** V4 cycle 4 (P1-B2): build the OpenAI `/v1/embeddings` request body.
 *  Wire shape: { input: texts[], model: string, encoding_format?: string }.
 *  Throws on bad input — ProtocolBase._wrap catches and surfaces as entry.error. */
function buildEmbedRequestBody(texts, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new TypeError('[openai-compatible] buildEmbedRequest: texts must be non-empty array');
  }
  for (let i = 0; i < texts.length; i++) {
    if (typeof texts[i] !== 'string') {
      throw new TypeError(
        `[openai-compatible] buildEmbedRequest: texts[${i}] must be string (got ${typeof texts[i]})`,
      );
    }
  }
  const body = {
    input: texts.slice(),
    model:
      typeof opts.model === 'string' && opts.model.length > 0
        ? opts.model
        : 'text-embedding-3-small',
  };
  if (typeof opts.encoding_format === 'string') {
    body.encoding_format = opts.encoding_format;
  }
  return body;
}

/** V4 cycle 4: parse the OpenAI `/v1/embeddings` response.
 *  Wire shape: { data: [{ embedding: number[], index: number, object: 'embedding' }] }.
 *  Returns { data: [{ embedding: number[] }] } preserving order. Throws on bad input. */
function parseEmbedResponseBody(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new TypeError('[openai-compatible] parseEmbedResponse: rawResponse must be object');
  }
  if (!Array.isArray(rawResponse.data) || rawResponse.data.length === 0) {
    throw new Error('[openai-compatible] parseEmbedResponse: rawResponse.data is empty or missing');
  }
  const out = [];
  for (let i = 0; i < rawResponse.data.length; i++) {
    const item = rawResponse.data[i];
    if (!item || !Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error(
        `[openai-compatible] parseEmbedResponse: data[${i}].embedding must be non-empty array`,
      );
    }
    for (let j = 0; j < item.embedding.length; j++) {
      if (typeof item.embedding[j] !== 'number' || !Number.isFinite(item.embedding[j])) {
        throw new TypeError(
          `[openai-compatible] parseEmbedResponse: data[${i}].embedding[${j}] must be finite number`,
        );
      }
    }
    out.push({ embedding: item.embedding.slice() });
  }
  return { data: out };
}

export class OpenAICompatibleProtocol extends ProtocolBase {
  /** @param {{eventBus:import('../../core/event-bus.js').EventBus, baseUrl?:string, apiKey?:string, defaultEmbeddingModel?:string}} opts */
  constructor(opts) {
    super({ ...opts, name: 'openai-compatible', kind: 'wire-format' });
    // V4 cycle 4: P1-B2 last-mile. Required for embed() to POST
    // /v1/embeddings. Optional for chat() — chat callers (deepseek /
    // qwen / openai) pass these via the provider layer, not the
    // protocol. embed() is the only method that uses these directly.
    this._embedBaseUrl = typeof opts?.baseUrl === 'string' ? opts.baseUrl : null;
    this._embedApiKey = typeof opts?.apiKey === 'string' ? opts.apiKey : null;
    this._defaultEmbeddingModel =
      typeof opts?.defaultEmbeddingModel === 'string' && opts.defaultEmbeddingModel.length > 0
        ? opts.defaultEmbeddingModel
        : 'text-embedding-3-small';
  }

  async _doBuildRequest(messages, options, model) {
    return buildRequestBody(messages, options, model);
  }

  async _doParseResponse(rawResponse) {
    const parsed = parseResponseBody(rawResponse);
    logFinishOrStop(parsed.finish_reason, { anthropic: !!this._anthropicMode });
    return parsed;
  }

  async _doParseStreamChunk(_chunk) {
    return { content: '', tool_calls: [] }; // STUB — PR 9
  }

  async _doBuildToolCallMessage(toolCall, result) {
    return buildToolResultMessage(toolCall, result); // delegate to PR 7
  }

  async _doParseToolCallDelta(_delta) {
    return { content: '', tool_calls: [] }; // STUB — PR 9
  }

  /**
   * V4 cycle 4: OpenAI `/v1/embeddings` end-to-end wire.
   *   - Builds the request body (P1-B2 wire-format).
   *   - POSTs to `${baseUrl}/v1/embeddings` with Bearer auth.
   *   - Parses `data.data[i].embedding` into a flat list of vectors.
   *   - Wrapped via ProtocolBase._wrap so the public surface stays
   *     `{ok, value}` (ErrorHandler convention) and never throws.
   *   - LLM gate (ADR-009): callers MUST mock fetch. No real network.
   *
   * @param {string[]} texts
   * @param {{model?:string, encoding_format?:string, fetchImpl?:Function, timeoutMs?:number}} [options]
   * @returns {Promise<{ok:true,value:number[][]}|{ok:false,error:{message:string}}>}
   */
  async embed(texts, options = {}) {
    return this._wrap('embed', async () => {
      if (!this._embedBaseUrl) {
        throw new Error(
          '[openai-compatible] embed: constructor opts.baseUrl is required (use the factory)',
        );
      }
      if (!this._embedApiKey) {
        throw new Error(
          '[openai-compatible] embed: constructor opts.apiKey is required (use the factory)',
        );
      }
      const opts = options && typeof options === 'object' ? options : {};
      const body = buildEmbedRequestBody(texts, {
        ...opts,
        model: opts.model || this._defaultEmbeddingModel,
      });
      const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
      const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 60000;
      const url = `${this._embedBaseUrl.replace(/\/+$/, '')}/v1/embeddings`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._embedApiKey}`,
        },
        body: JSON.stringify(body),
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
      });
      if (!res || typeof res.ok !== 'boolean') {
        throw new Error('[openai-compatible] embed: fetch returned no response');
      }
      if (!res.ok) {
        const errBody = await safeReadError(res);
        throw new Error(
          `[openai-compatible] embed: HTTP ${res.status} ${res.statusText || ''} ${errBody}`.trim(),
        );
      }
      const raw = await res.json();
      const parsed = parseEmbedResponseBody(raw);
      // Flatten to number[][] so downstream consumers (vector backend DI
      // seam) get the canonical shape directly: texts[i] → vectors[i].
      return parsed.data.map((d) => d.embedding);
    });
  }
}

/** Best-effort read of an error response body. Never throws. */
async function safeReadError(res) {
  try {
    if (typeof res.text === 'function') {
      const t = await res.text();
      return t ? t.slice(0, 500) : '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Factory: IProtocol-shaped object backed by an OpenAICompatibleProtocol instance.
 * Mirrors the IProvider.validate pattern: validate(protocol) checks name + 5 methods.
 * V4 cycle 4: also exposes embed() (P1-B2 last-mile) for direct consumers (e2e,
 * vector backend DI seam). Chat-only callers (deepseek/qwen/openai) can keep
 * calling this factory with { eventBus } only — embed is unused on their path.
 * @param {{eventBus:import('../../core/event-bus.js').EventBus, baseUrl?:string, apiKey?:string, defaultEmbeddingModel?:string}} opts
 */
export function createOpenAICompatibleProtocol(opts) {
  const i = new OpenAICompatibleProtocol(opts);
  return {
    name: i.name,
    buildRequest: i.buildRequest.bind(i),
    parseResponse: i.parseResponse.bind(i),
    parseStreamChunk: i.parseStreamChunk.bind(i),
    buildToolCallMessage: i.buildToolCallMessage.bind(i),
    parseToolCallDelta: i.parseToolCallDelta.bind(i),
    embed: i.embed.bind(i),
  };
}
