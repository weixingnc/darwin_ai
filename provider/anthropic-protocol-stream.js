/** Anthropic streaming protocol — PR 14a2. Parallel to PR 14a1 (non-stream) + PR 8 (openai stream).
 *  Anthropic SSE: event: <type>\ndata: <json>\n\n. 6 event types: message_start → message_stop.
 *  Yield shape: { content, toolCalls, finishReason, raw } / { type: 'done' } / { type: 'error', error }.
 *  A-3: buildStreamRequest delegates to PR 14a1. PR 7b reuse: parseAssistantToolCalls for v2 tool_calls.
 *  A-4: no process.env reads. D-3: ErrorHandler.wrap; never throws. Skeleton only — real API in PR 14b. */

import { ErrorHandler } from '../core/error-handler.js';
import { createAnthropicProtocol } from './anthropic-protocol.js';
import { parseAssistantToolCalls } from './protocol/tool-call.js';

const SE = 'provider:stream:error';

function splitEvents(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  return { events: parts.slice(0, -1), rest: parts.at(-1) || '' };
}

function extractSseEvent(block) {
  let eventType = null,
    dataPayload = null;
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(':')) {
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

function onMessageStart(state, p) {
  if (p.message && typeof p.message === 'object') {
    state.message = p.message;
    if (p.message.usage && typeof p.message.usage === 'object') {
      state.usage = { ...state.usage, ...p.message.usage };
    }
  }
  return 'skip';
}

function onContentBlockStart(state, p) {
  if (p.content_block && p.content_block.type === 'tool_use') {
    state.toolCallAcc.set(p.index, {
      id: typeof p.content_block.id === 'string' ? p.content_block.id : '',
      name: typeof p.content_block.name === 'string' ? p.content_block.name : '',
      inputJson: '',
      input: null,
    });
    return 'yield';
  }
  return 'skip';
}

function onContentBlockDelta(state, p) {
  const d = p.delta;
  if (!d || typeof d !== 'object') {
    return 'skip';
  }
  if (d.type === 'text_delta' && typeof d.text === 'string') {
    state.content += d.text;
    return 'yield';
  }
  if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
    const acc = state.toolCallAcc.get(p.index);
    if (acc) {
      acc.inputJson += d.partial_json;
    }
    return 'yield';
  }
  return 'skip';
}

function onContentBlockStop(state, p) {
  const acc = state.toolCallAcc.get(p.index);
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

function onMessageDelta(state, p) {
  if (p.delta && p.delta.stop_reason) {
    state.finishReason = p.delta.stop_reason;
  }
  if (p.usage && typeof p.usage === 'object') {
    state.usage = { ...state.usage, ...p.usage };
  }
  return 'yield';
}

function applyEvent(state, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return 'skip';
  }
  switch (parsed.type) {
    case 'message_start':
      return onMessageStart(state, parsed);
    case 'content_block_start':
      return onContentBlockStart(state, parsed);
    case 'content_block_delta':
      return onContentBlockDelta(state, parsed);
    case 'content_block_stop':
      return onContentBlockStop(state, parsed);
    case 'message_delta':
      return onMessageDelta(state, parsed);
    case 'message_stop':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'skip';
  }
}

function snapshotToolCalls(state) {
  if (state.toolCallAcc.size === 0) {
    return [];
  }
  const sorted = Array.from(state.toolCallAcc.keys()).sort((a, b) => a - b);
  const wire = sorted.map((k) => {
    const acc = state.toolCallAcc.get(k);
    const args = typeof acc.input === 'string' ? acc.input : JSON.stringify(acc.input || {});
    return { id: acc.id, type: 'function', function: { name: acc.name, arguments: args } };
  });
  return parseAssistantToolCalls({ role: 'assistant', tool_calls: wire });
}

function snapshot(state) {
  return {
    content: state.content,
    toolCalls: snapshotToolCalls(state),
    finishReason: state.finishReason,
    raw: { usage: state.usage, message: state.message },
  };
}

function newState() {
  return { content: '', finishReason: null, usage: {}, message: null, toolCallAcc: new Map() };
}

function processEventBlock(state, ev, safeParse, bus) {
  const { eventType, dataPayload } = extractSseEvent(ev);
  if (dataPayload === null || dataPayload.length === 0) {
    return { kind: 'skip' };
  }
  const parsed = safeParse(dataPayload);
  if (!parsed.ok) {
    bus.emit(SE, { provider: 'anthropic', error: parsed.error });
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
    bus.emit(SE, { provider: 'anthropic', error: errInfo });
    return { kind: 'yield-error', error: errInfo };
  }
  return { kind: 'yield-snapshot' };
}

export class AnthropicProtocolStream {
  constructor(opts) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[anthropic-stream] constructor: opts.eventBus is required');
    }
    this.name = 'anthropic-stream';
    this._bus = opts.eventBus;
    this._fallback = createAnthropicProtocol({ eventBus: opts.eventBus });
  }

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
          const r = processEventBlock(state, ev, safeParse, this._bus);
          if (r.kind === 'skip') {
            continue;
          }
          if (r.kind === 'done') {
            yield { type: 'done' };
            return;
          }
          if (r.kind === 'yield-error') {
            yield { type: 'error', error: r.error };
            continue;
          }
          yield snapshot(state);
        }
      }
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

export function createAnthropicProtocolStream(opts) {
  const i = new AnthropicProtocolStream(opts);
  return {
    name: i.name,
    buildStreamRequest: i.buildStreamRequest.bind(i),
    parseStream: i.parseStream.bind(i),
  };
}
