/**
 * OpenAI-compatible streaming protocol — PR 10.
 *
 * v2 design (A-3 fix): non-streaming (PR 8) + streaming (PR 10) are two
 * independent wire-format layers. v1 wrote the provider twice; v2 splits
 * the concern so the provider wires each once.
 *
 * Covers 9/10 domestic LLM (DeepSeek / Qwen / GLM / Moonshot / Kimi) on the
 * OpenAI SSE format. Anthropic / Google streaming comes in PR 11+ via Darwin
 * self-impl.
 *
 * v1 飞书 bug 6 streaming-path invariants (must match non-streaming):
 *  #1 tool_calls format: 1 assistant + N role:tool, NEVER per-toolCall.
 *  #2 tool_call_id: preserved verbatim.
 *  #3 MAX_TOOL_ROUNDS=5: orchestrator (PR 11+) enforces; protocol passes through.
 *  #4 try/catch: every chunk parsed inside ErrorHandler.wrap; errors yield
 *     {type:'error', error} and CONTINUE (never abort the stream).
 *  #5 finish_reason: yielded on the final chunk of every turn.
 *  #6 stop_reason: N/A (Anthropic-only); non-stream PR 8 handles it.
 *
 * SSE wire format: data: {json}\n\n + terminating data: [DONE]\n\n.
 * Yield shapes: { content, toolCalls, finishReason, raw } per chunk,
 * { type: 'done' } on [DONE], { type: 'error', error } on parse fail.
 * Each yield carries the FULL accumulated state since stream start.
 */

import { ErrorHandler } from '../../core/error-handler.js';
import { createOpenAICompatibleProtocol } from './openai-compatible.js';
import { splitThinkBlocks } from './_shared.js';

const DONE_MARKER = '[DONE]';

/** Shallow-merge a delta tool_call into an existing accumulator entry. */
function mergeToolCallDelta(acc, delta) {
  if (!delta || typeof delta !== 'object') {
    return acc;
  }
  const out = { ...acc };
  if (typeof delta.id === 'string') {
    out.id = delta.id;
  }
  if (typeof delta.type === 'string') {
    out.type = delta.type;
  }
  if (delta.function && typeof delta.function === 'object') {
    const fn = { ...(out.function || {}) };
    if (typeof delta.function.name === 'string') {
      fn.name = delta.function.name;
    }
    if (typeof delta.function.arguments === 'string') {
      fn.arguments = (fn.arguments || '') + delta.function.arguments;
    }
    out.function = fn;
  }
  return out;
}

/** Apply a delta's tool_calls array to the Map<index,call> accumulator. */
function applyToolCallDeltas(acc, deltaToolCalls) {
  if (!Array.isArray(deltaToolCalls)) {
    return acc;
  }
  for (const d of deltaToolCalls) {
    if (!d || typeof d !== 'object') {
      continue;
    }
    const idx = typeof d.index === 'number' ? d.index : 0;
    acc.set(idx, mergeToolCallDelta(acc.get(idx) || {}, d));
  }
  return acc;
}

/** Snapshot the tool_call accumulator as a sorted-by-index array. */
function snapshotToolCalls(acc) {
  return Array.from(acc.keys())
    .sort((a, b) => a - b)
    .map((k) => acc.get(k));
}

/** Split a buffer into complete SSE events (each terminated by \n\n) and a remainder. */
function splitEvents(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  return { events: parts.slice(0, -1), rest: parts[parts.length - 1] || '' };
}

/** Extract the `data: ...` payload from one SSE event block (skip comments / blanks). */
function extractDataPayload(eventBlock) {
  if (typeof eventBlock !== 'string') {
    return null;
  }
  for (const rawLine of eventBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      return line.slice(5).trim();
    }
  }
  return null;
}

/** Apply one delta's effects on the accumulator; returns {content, finishReason} snapshot. */
function applyDelta(state, raw) {
  const choice = Array.isArray(raw.choices) && raw.choices[0];
  if (!choice) {
    return null;
  }
  const delta = choice.delta || {};
  // V45: capture API-level reasoning field (separate stream on DeepSeek R1 / Qwen QwQ / GLM-Z1).
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    state.reasoning += delta.reasoning_content;
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    // V45: keep the raw text in rawContent so the unclosed think boundary
    // is preserved across chunk boundaries. Re-parse the full accumulated
    // raw text on every delta to recompute visible content + reasoning.
    // O(n) per delta; n is small (a turn fits in ~100k tokens typically).
    const prevRawLen = state.rawContent.length;
    state.rawContent += delta.content;
    // V45: recompute visible content from the full raw text (handles
    // unclosed <think> across chunks). The inline-think slice in the
    // current raw text REPLACES the previous thinking slice; we only
    // count the NEW portion toward state.reasoning. The API-level
    // reasoning_content branch above still appends to state.reasoning
    // because it arrives in a separate field.
    const split = splitThinkBlocks(state.rawContent);
    state.content = split.visible;
    // Compute the delta contribution to reasoning by re-parsing the
    // substring state.rawContent.slice(0, prevRawLen) and the new full
    // text, then taking the difference. For streaming with small deltas
    // this is correct because the only thing that can grow is the
    // currently-open think block, or a new block, both of which fall
    // entirely in the new tail.
    const prevSplit = splitThinkBlocks(state.rawContent.slice(0, prevRawLen));
    if (split.reasoning.length > prevSplit.reasoning.length) {
      state.reasoning += split.reasoning.slice(prevSplit.reasoning.length);
    }
  }
  if (Array.isArray(delta.tool_calls)) {
    applyToolCallDeltas(state.toolCallAcc, delta.tool_calls);
  }
  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  return {
    content: state.content,
    reasoning: state.reasoning,
    finishReason: state.finishReason,
    raw,
  };
}

export class OpenAICompatibleStreamProtocol {
  /** @param {{eventBus:import('../../core/event-bus.js').EventBus}} opts */
  constructor(opts) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[openai-compatible-stream] constructor: opts.eventBus is required');
    }
    this.name = 'openai-compatible-stream';
    this._bus = opts.eventBus;
    // Reuse PR 8's non-streaming protocol for buildStreamRequest — one wire
    // format, two layers (A-3 fix).
    this._fallback = createOpenAICompatibleProtocol({ eventBus: opts.eventBus });
  }

  /**
   * Build a stream:true OpenAI request body. Delegates to PR 8's buildRequest
   * then flips stream:true. Returns the same ErrorHandler entry shape.
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
   * Parse an SSE stream from a fetch Response into accumulated chunks.
   * Async generator. NEVER throws. Per-chunk errors yield {type:'error'}.
   * @param {Response|{body:ReadableStream|null}} response
   * @param {{timeoutMs?:number}} [_options] reserved for future limits
   */
  async *parseStream(response, _options = {}) {
    if (!response || !response.body) {
      yield { type: 'done' };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const state = {
      content: '',
      rawContent: '',
      reasoning: '',
      finishReason: null,
      toolCallAcc: new Map(),
    };
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
          // eventOutcome: 'done' | 'skip' | 'error' | 'chunk'
          const outcome = this._classifySseEvent(ev, safeParse);
          if (outcome === 'done') {
            yield { type: 'done' };
            return;
          }
          if (outcome === 'skip') {
            continue;
          }
          if (outcome === 'error') {
            const err = safeParse(extractDataPayload(ev) || '');
            yield { type: 'error', error: err.ok ? undefined : err.error };
            continue;
          }
          // outcome === 'chunk'
          const parsed = safeParse(extractDataPayload(ev));
          if (!parsed.ok) {
            continue;
          }
          const snap = applyDelta(state, parsed.value);
          if (!snap) {
            continue;
          }
          yield {
            content: snap.content,
            reasoning: snap.reasoning, // V45: API-level + inline think blocks; '' if none.
            toolCalls: snapshotToolCalls(state.toolCallAcc),
            finishReason: snap.finishReason,
            raw: snap.raw,
          };
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Classify an SSE event block (no yield, no parse, no side effects).
   * Returns 'done' / 'skip' / 'error' / 'chunk'. Extracted to keep
   * parseStream's cyclomatic complexity low.
   */
  _classifySseEvent(ev, safeParse) {
    const payload = extractDataPayload(ev);
    if (payload === null) {
      return 'skip';
    }
    if (payload === DONE_MARKER) {
      return 'done';
    }
    const entry = safeParse(payload);
    if (!entry.ok) {
      return 'error';
    }
    const choice = Array.isArray(entry.value.choices) && entry.value.choices[0];
    if (!choice) {
      return 'skip';
    }
    return 'chunk';
  }
}
