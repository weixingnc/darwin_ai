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

export class OpenAICompatibleProtocol extends ProtocolBase {
  /** @param {{eventBus:import('../../core/event-bus.js').EventBus}} opts */
  constructor(opts) {
    super({ ...opts, name: 'openai-compatible', kind: 'wire-format' });
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
}

/**
 * Factory: IProtocol-shaped object backed by an OpenAICompatibleProtocol instance.
 * Mirrors the IProvider.validate pattern: validate(protocol) checks name + 5 methods.
 * @param {{eventBus:import('../../core/event-bus.js').EventBus}} opts
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
  };
}
