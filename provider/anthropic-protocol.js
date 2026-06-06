/**
 * Anthropic protocol (non-streaming) — PR 14a1.
 *
 * Wire-format conversion: openai-style messages → Anthropic Messages API.
 *  - system message → top-level `system` field (string or array of blocks)
 *  - user content (string) → `[{type:'text', text}]` content array
 *  - assistant tool_calls → `[{type:'tool_use', id, name, input}]` content array
 *  - tool results (role:tool) → user message with `[{type:'tool_result', tool_use_id, content}]`
 *  - default `max_tokens=1024` + `anthropic_version: '2023-06-01'`
 *
 * parseResponse: anthropic content blocks → v2 normalized shape.
 *  - text blocks → assistant content (concatenated)
 *  - tool_use blocks → v2 tool_calls (id+name+arguments JSON string), via PR 7b formatToolCalls
 *  - stop_reason → finish_reason (verbatim: end_turn / max_tokens / tool_use / stop_sequence)
 *  - usage: { input_tokens, output_tokens } preserved as-is
 *  - error responses (type:'error') → throw ProviderError-shaped rejection
 *
 * v2 design: extends ProtocolBase (PR 7a). Streaming is OUT OF SCOPE — PR 14a2.
 * Stub for parseStreamChunk / parseToolCallDelta (parallel to PR 8 design).
 *
 * v1 lessons honored:
 *  A-3: provider/format logic isolated behind IProtocol (no double-impl)
 *  A-4: no process.env reads in this file; api_key lives in HTTP layer (PR 14b)
 *  D-1/2/3: tool-call format conversion delegated to PR 7b tool-call.js
 *  D-4: every public method wrapped by ProtocolBase — never throws to caller
 */

import { ProtocolBase } from './protocol/base.js';
import {
  buildToolResultMessage,
  formatToolCalls,
  parseAssistantToolCalls,
} from './protocol/tool-call.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

/** Convert v2 plain tool defs → Anthropic tools shape (no `type:'function'` envelope). */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools.map((t) => {
    if (!t || typeof t !== 'object') {
      return t;
    }
    // If already Anthropic-shaped (has input_schema), pass through.
    if (t.input_schema) {
      return {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      };
    }
    return {
      name: t.name,
      description: t.description,
      input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
    };
  });
}

/** Coerce a user/assistant `content` field to an array of blocks. */
function toContentArray(content) {
  if (Array.isArray(content)) {
    return content;
  }
  if (content === null || content === undefined || content === '') {
    return [];
  }
  return [{ type: 'text', text: typeof content === 'string' ? content : String(content) }];
}

/** Parse the `arguments` field of a v2 tool_call (string JSON or object). */
function parseToolArgs(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  if (args && typeof args === 'object') {
    return args;
  }
  return {};
}

/** Convert one openai-style tool_call → Anthropic tool_use block. */
function toolCallToToolUse(tc) {
  return {
    type: 'tool_use',
    id: typeof tc.id === 'string' ? tc.id : '',
    name: typeof tc.function?.name === 'string' ? tc.function.name : '',
    input: parseToolArgs(tc.function?.arguments),
  };
}

/** Convert a v2 role:tool message → Anthropic user message with tool_result blocks. */
function toolMessageToUser(toolMsg) {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id : '',
        content:
          typeof toolMsg.content === 'string'
            ? toolMsg.content
            : JSON.stringify(toolMsg.content ?? ''),
      },
    ],
  };
}

/** Convert one v2 message → zero-or-more Anthropic messages. */
function convertMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return [];
  }
  const role = msg.role;
  if (role === 'system') {
    return { __system: msg.content };
  }
  if (role === 'tool') {
    return [toolMessageToUser(msg)];
  }
  if (role === 'user') {
    return [{ role: 'user', content: toContentArray(msg.content) }];
  }
  if (role === 'assistant') {
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blocks = [];
      const textBlocks = toContentArray(msg.content);
      for (const b of textBlocks) {
        blocks.push(b);
      }
      for (const tc of msg.tool_calls) {
        blocks.push(toolCallToToolUse(tc));
      }
      return [{ role: 'assistant', content: blocks }];
    }
    return [{ role: 'assistant', content: toContentArray(msg.content) }];
  }
  // Unknown role: skip silently (defensive — v1 had unknown-role blow-ups).
  return [];
}

/** Build the Anthropic Messages API request body. Throws on malformed input. */
function buildRequestBody(messages, options = {}, model = '') {
  const opts = options && typeof options === 'object' ? options : {};
  const src = Array.isArray(messages) ? messages : [];
  const { messages: out, system } = convertMessagesToAnthropic(src);
  const body = {
    model: String(model || ''),
    messages: out,
    max_tokens: resolveMaxTokens(opts.max_tokens),
    stream: false,
    anthropic_version: ANTHROPIC_VERSION,
  };
  applyOptions(body, opts, system);
  return body;
}

/** Walk a list of v2 messages, splitting out system content. */
function convertMessagesToAnthropic(src) {
  const out = [];
  let system = '';
  for (const m of src) {
    const r = convertMessage(m);
    if (!r) {
      continue;
    }
    if (r.__system !== undefined) {
      system = appendSystem(system, r.__system);
      continue;
    }
    for (const msg of r) {
      if (msg) {
        out.push(msg);
      }
    }
  }
  return { messages: out, system };
}

/** Append to the accumulated system string (newline-separated). */
function appendSystem(current, addition) {
  const extra = typeof addition === 'string' ? addition : JSON.stringify(addition);
  return current ? `${current}\n${extra}` : extra;
}

/** Resolve max_tokens: caller-supplied positive number wins, else default 1024. */
function resolveMaxTokens(value) {
  return typeof value === 'number' && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

/** Apply optional Anthropic request fields to a body. */
function applyOptions(body, opts, system) {
  if (system.length > 0) {
    body.system = system;
  }
  if (typeof opts.temperature === 'number') {
    body.temperature = opts.temperature;
  }
  if (typeof opts.top_p === 'number') {
    body.top_p = opts.top_p;
  }
  const tools = toAnthropicTools(opts.tools);
  if (tools !== undefined) {
    body.tools = tools;
  }
}

/** Extract concatenated text + tool_use blocks from an Anthropic content array. */
function parseContentBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  const textParts = [];
  const toolUses = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') {
      continue;
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      toolUses.push({
        id: typeof b.id === 'string' ? b.id : '',
        type: 'function',
        function: {
          name: typeof b.name === 'string' ? b.name : '',
          arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}),
        },
      });
    }
    // tool_result blocks in assistant output are not expected; ignore.
  }
  return { content: textParts.join(''), toolUses };
}

/** Parse an Anthropic response into v2 unified shape. Throws on malformed input. */
function parseResponseBody(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new TypeError('[anthropic] parseResponse: rawResponse must be object');
  }
  if (isErrorResponse(rawResponse)) {
    throw buildProviderError(rawResponse);
  }
  const { content: text, toolUses } = parseContentBlocks(rawResponse.content);
  return {
    content: text,
    tool_calls: extractToolCalls(toolUses),
    usage: extractUsage(rawResponse.usage),
    finish_reason: extractFinishReason(rawResponse.stop_reason),
  };
}

/** Detect an Anthropic error response. */
function isErrorResponse(raw) {
  if (raw.type === 'error') {
    return true;
  }
  return raw.error && typeof raw.error === 'object' && raw.error.message;
}

/** Build a normalized ProviderError from an Anthropic error response. */
function buildProviderError(raw) {
  const errInfo = raw.error && typeof raw.error === 'object' ? raw.error : {};
  const err = new Error(
    `[anthropic] ${errInfo.type || 'api_error'}: ${errInfo.message || 'unknown error'}`,
  );
  err.name = 'ProviderError';
  err.status = typeof raw.status === 'number' ? raw.status : undefined;
  err.type = errInfo.type;
  err.raw = raw;
  return err;
}

/** Extract v2 normalized tool_calls by routing through PR 7b (MAX_TOOL_ROUNDS-safe). */
function extractToolCalls(toolUses) {
  if (toolUses.length === 0) {
    return [];
  }
  const wire = formatToolCalls(toolUses, []);
  const assistantMsg = wire.find((m) => m.role === 'assistant');
  return parseAssistantToolCalls(assistantMsg);
}

/** Extract usage payload with safe default. */
function extractUsage(usage) {
  return usage && typeof usage === 'object' ? usage : {};
}

/** Extract stop_reason with safe default. */
function extractFinishReason(reason) {
  return reason === null || reason === undefined ? 'unknown' : String(reason);
}

export class AnthropicProtocol extends ProtocolBase {
  /** @param {{eventBus:import('../core/event-bus.js').EventBus}} opts */
  constructor(opts) {
    super({ ...opts, name: 'anthropic', kind: 'wire-format' });
  }

  async _doBuildRequest(messages, options, model) {
    return buildRequestBody(messages, options, model);
  }

  async _doParseResponse(rawResponse) {
    return parseResponseBody(rawResponse);
  }

  async _doParseStreamChunk(_chunk) {
    // STUB — PR 14a2 will implement SSE event parsing.
    return { content: '', tool_calls: [] };
  }

  async _doBuildToolCallMessage(toolCall, result) {
    // Delegate to PR 7b — tool_call_id preserved verbatim.
    return buildToolResultMessage(toolCall, result);
  }

  async _doParseToolCallDelta(_delta) {
    // STUB — PR 14a2.
    return { content: '', tool_calls: [] };
  }
}

/**
 * Factory: IProtocol-shaped object backed by an AnthropicProtocol instance.
 * Mirrors the createOpenAICompatibleProtocol pattern (PR 8).
 * @param {{eventBus:import('../core/event-bus.js').EventBus}} opts
 */
export function createAnthropicProtocol(opts) {
  const i = new AnthropicProtocol(opts);
  return {
    name: i.name,
    buildRequest: i.buildRequest.bind(i),
    parseResponse: i.parseResponse.bind(i),
    parseStreamChunk: i.parseStreamChunk.bind(i),
    buildToolCallMessage: i.buildToolCallMessage.bind(i),
    parseToolCallDelta: i.parseToolCallDelta.bind(i),
  };
}
