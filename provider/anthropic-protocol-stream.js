/** Anthropic streaming protocol — PR 14a2. Parallel to PR 14a1 (non-stream) + PR 8 (openai stream).
 *  Anthropic SSE: event: <type>\ndata: <json>\n\n. 6 event types: message_start → message_stop.
 *  Yield shape: { content, toolCalls, finishReason, raw } / { type: 'done' } / { type: 'error', error }.
 *  A-3: buildStreamRequest delegates to PR 14a1. PR 7b reuse: parseAssistantToolCalls for v2 tool_calls.
 *  A-4: no process.env reads. D-3: ErrorHandler.wrap; never throws. F-7: ≤ 280 lines.
 *  Skeleton only (v2 启动哲学): real Anthropic API wiring lives in PR 14b. */

import { ErrorHandler } from '../core/error-handler.js';
import { createAnthropicProtocol } from './anthropic-protocol.js';
import { parseAssistantToolCalls } from './protocol/tool-call.js';

const STREAM_ERROR_EVENT = 'provider:stream:error';
const PROVIDER_NAME = 'anthropic-stream';

/** Split a buffer into complete SSE event blocks (terminated by \n\n) + a remainder. */
function splitEvents(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  return { events: parts.slice(0, -1), rest: parts[parts.length - 1] || '' };
}

/** Extract `event:` + `data:` payloads from a single SSE event block. */
function extractSseEvent(block) {
  let eventType = null;
  let dataPayload = null;
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataPayload = line.slice(5).trim();
    }
  }
  return { eventType, dataPayload };
}

function handleMessageStart(state, parsed) {
  if (parsed.message && typeof parsed.message === 'object') {
    state.message = parsed.message;
    if (parsed.message.usage && typeof parsed.message.usage === 'object') {
      state.usage = { ...state.usage, ...parsed.message.usage };
    }
  }
  return 'skip';
}

function handleContentBlockStart(state, parsed) {
  if (parsed.content_block && parsed.content_block.type === 'tool_use') {
    state.toolCallAcc.set(parsed.index, {
      id: typeof parsed.content_block.id === 'string' ? parsed.content_block.id : '',
      name: typeof parsed.content_block.name === 'string' ? parsed.content_block.name : '',
      inputJson: '',
      input: null,
    });
    return 'yield';
  }
  return 'skip';
}

function handleContentBlockDelta(state, parsed) {
  const delta = parsed.delta;
  if (!delta || typeof delta !== 'object') {
    return 'skip';
  }
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    state.content += delta.text;
    return 'yield';
  }
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    const acc = state.toolCallAcc.get(parsed.index);
    if (acc) {
      acc.inputJson += delta.partial_json;
    }
    return 'yield';
  }
  return 'skip';
}

function handleContentBlockStop(state, parsed) {
  const acc = state.toolCallAcc.get(parsed.index);
  if (acc && acc.input === null) {
    try {
      acc.input = JSON.parse(acc.inputJson);
    } catch {
      acc.input = {};
    }
    return 'yield';
  }
  return 'skip';
}

function handleMessageDelta(state, parsed) {
  if (parsed.delta && parsed.delta.stop_reason) {
    state.finishReason = parsed.delta.stop_reason;
  }
  if (parsed.usage && typeof parsed.usage === 'object') {
    state.usage = { ...state.usage, ...parsed.usage };
  }
  return 'yield';
}

/** Map one Anthropic stream event onto the accumulator. Returns yield directive. */
function applyEvent(state, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return 'skip';
  }
  switch (parsed.type) {
    case 'message_start':
      return handleMessageStart(state, parsed);
    case 'content_block_start':
      return handleContentBlockStart(state, parsed);
    case 'content_block_delta':
      return handleContentBlockDelta(state, parsed);
    case 'content_block_stop':
      return handleContentBlockStop(state, parsed);
    case 'message_delta':
      return handleMessageDelta(state, parsed);
    case 'message_stop':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'skip';
  }
}

/** Build v2 normalized tool_calls from the accumulator via PR 7b. */
function snapshotToolCalls(state) {
  if (state.toolCallAcc.size === 0) {
    return [];
  }
  const sorted = Array.from(state.toolCallAcc.keys()).sort((a, b) => a - b);
  const wire = sorted.map((k) => {
    const acc = state.toolCallAcc.get(k);
    const args = typeof acc.input === 'string' ? acc.input : JSON.stringify(acc.input || {});
    return {
      id: acc.id,
      type: 'function',
      function: { name: acc.name, arguments: args },
    };
  });
  return parseAssistantToolCalls({ role: 'assistant', tool_calls: wire });
}

/** Build the per-yield snapshot (parallel to openai stream shape). */
function snapshot(state) {
  return {
    content: state.content,
    toolCalls: snapshotToolCalls(state),
    finishReason: state.finishReason,
    raw: { usage: state.usage, message: state.message },
  };
}

/** Create a fresh state object for a new stream. */
function newState() {
  return { content: '', finishReason: null, usage: {}, message: null, toolCallAcc: new Map() };
}

/** Process a single SSE event block. Returns {kind, payload, error}. */
function processEventBlock(state, ev, safeParse, bus) {
  const { eventType, dataPayload } = extractSseEvent(ev);
  if (dataPayload === null || dataPayload.length === 0) {
    return { kind: 'skip' };
  }
  const parsed = safeParse(dataPayload);
  if (!parsed.ok) {
    bus.emit(STREAM_ERROR_EVENT, { provider: 'anthropic', error: parsed.error });
    return { kind: 'yield-error', error: parsed.error };
  }
  if (!eventType && parsed.value && parsed.value.type) {
    parsed.value.__eventType = parsed.value.type;
  }
  const directive = applyEvent(state, parsed.value);
  if (directive === 'skip') {
    return { kind: 'skip' };
  }
  if (directive === 'done') {
    return { kind: 'done' };
  }
  if (directive === 'error') {
    const errInfo = parsed.value.error || parsed.value;
    bus.emit(STREAM_ERROR_EVENT, { provider: 'anthropic', error: errInfo });
    return { kind: 'yield-error', error: errInfo };
  }
  return { kind: 'yield-snapshot' };
}

export class AnthropicProtocolStream {
  /** @param {{eventBus:import('../core/event-bus.js').EventBus}} opts */
  constructor(opts) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[anthropic-stream] constructor: opts.eventBus is required');
    }
    this.name = PROVIDER_NAME;
    this._bus = opts.eventBus;
    // A-3: reuse PR 14a1's buildRequest so the stream layer never diverges.
    this._fallback = createAnthropicProtocol({ eventBus: opts.eventBus });
  }

  /**
   * Build a stream:true Anthropic request body. Delegates to PR 14a1's
   * buildRequest then flips stream:true. Returns ErrorHandler-shaped entry.
   */
  async buildStreamRequest(messages, options = {}, model = '') {
    return ErrorHandler.wrapAsync(
      async () => {
        const entry = await this._fallback.buildRequest(messages, options, model);
        if (!entry.ok) {
          throw new Error(`buildStreamRequest: buildRequest failed: ${entry.error.message}`);
        }
        return { ...entry.value, stream: true };
      },
      { phase: 'buildStreamRequest' },
    )();
  }

  /**
   * Parse an Anthropic SSE stream from a fetch Response. Async generator.
   * NEVER throws. Per-chunk errors yield {type:'error'} + emit provider:stream:error.
   * @param {Response|{body:ReadableStream|null}} response
   */
  async *parseStream(response, _options = {}) {
    if (!response || !response.body) {
      yield { type: 'done' };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const state = newState();
    const safeParse = (raw) =>
      ErrorHandler.wrap(() => JSON.parse(raw), { phase: 'parseStreamChunk' })();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitEvents(buffer);
        buffer = rest;
        for (const ev of events) {
          const result = processEventBlock(state, ev, safeParse, this._bus);
          if (result.kind === 'skip') {
            continue;
          }
          if (result.kind === 'done') {
            yield { type: 'done' };
            return;
          }
          if (result.kind === 'yield-error') {
            yield { type: 'error', error: result.error };
            continue;
          }
          yield snapshot(state);
        }
      }
      // Stream ended without an explicit message_stop — still close cleanly.
      yield { type: 'done' };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * Factory: IProtocol-shaped object backed by an AnthropicProtocolStream instance.
 * Mirrors the createOpenAICompatibleProtocol pattern (PR 8) + createAnthropicProtocol (PR 14a1).
 * @param {{eventBus:import('../core/event-bus.js').EventBus}} opts
 */
export function createAnthropicProtocolStream(opts) {
  const i = new AnthropicProtocolStream(opts);
  return {
    name: i.name,
    buildStreamRequest: i.buildStreamRequest.bind(i),
    parseStream: i.parseStream.bind(i),
  };
}
