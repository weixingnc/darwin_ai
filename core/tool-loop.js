// core/tool-loop.js — PR-25: Tool Call Loop (multi-round + retry/fallback/deadlock)
// Design: docs/PR_DESIGN_23_24_25.md §PR-25
// Reference: docs/OPENCLAW_PROMPT_REFERENCE.md §4-§5
// Exports: toolLoop, classifyError, retryWithBackoff, MAX_TURNS, resolveMaxTurns, TOOL_ERROR_CODES.
// Never throws to caller. 4 deadlock detectors. Retry only NETWORK errors.

import {
  TOOL_NOT_FOUND,
  TOOL_INVALID_ARGS,
  TOOL_EXEC_FAILED,
  TIMEOUT,
  callTool,
} from './tool-catalog.js';

export const TOOL_ERROR_CODES = Object.freeze({
  TOOL_NOT_FOUND,
  TOOL_INVALID_ARGS,
  TOOL_EXEC_FAILED,
  TIMEOUT,
});

const BT = 24,
  TP = 8,
  MN = 32,
  MX = 160,
  MR = 3,
  RB = 300,
  RJ = 0.2;

export function resolveMaxTurns(n = 1) {
  const safe = Math.max(1, Math.floor(Number(n) || 1));
  return Math.min(MX, Math.max(MN, BT + safe * TP));
}

export const MAX_TURNS = resolveMaxTurns(1);

// OpenClaw RECOVERABLE_TOOL_ERROR_KEYWORDS + NETWORK retry keywords (lowercased).
const REC_KW = ['required', 'missing', 'invalid', 'must be', 'must have', 'needs', 'requires'];
const NET_KW = ['econnreset', 'etimedout', 'eai_again', 'enotfound', '5xx', 'rate limit', '429'];

export function classifyError(err) {
  const msg = String((err && (err.message || err.error || err)) || '').toLowerCase();
  const code = err && err.errorCode;
  if (code === TOOL_INVALID_ARGS || REC_KW.some((k) => msg.includes(k))) {
    return 'RECOVERABLE';
  }
  if (code === TIMEOUT || NET_KW.some((k) => msg.includes(k))) {
    return 'NETWORK';
  }
  return 'PERMANENT';
}

function jitter(base, ratio = RJ) {
  return Math.max(0, Math.floor(base * (1 + (Math.random() * 2 - 1) * ratio)));
}

export async function retryWithBackoff(fn, opts = {}) {
  const max = Math.floor(opts.maxAttempts || MR);
  const base = opts.baseMs || RB;
  const j = opts.jitter !== undefined ? opts.jitter : RJ;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let a = 1; a <= max; a += 1) {
    try {
      return await fn(a);
    } catch (e) {
      last = e;
      if (a < max) {
        await sleep(jitter(base * 2 ** (a - 1), j));
      }
    }
  }
  throw last;
}

async function tryFallbackChain(catalog, name, args, ctx) {
  const entry = catalog.get(name);
  if (!entry || !entry.fallback || entry.fallback.length === 0) {
    return null;
  }
  for (const alt of entry.fallback) {
    try {
      return await retryWithBackoff(async () => {
        const r = await callTool(catalog, alt, args, ctx);
        if (!r.ok) {
          throw new Error(`fallback '${alt}' failed: ${r.errorCode} ${r.error || ''}`);
        }
        return { value: r.result, via: alt };
      }, { maxAttempts: 2, baseMs: RB, jitter: 0.1, sleep: ctx && ctx._sleep });
    } catch (_) {
      /* try next */
    }
  }
  return { exhausted: true };
}

// 4 deadlock detectors (OpenClaw ToolLoopDetection style, simplified).
function detectUnknownRepeat(h) {
  let n = 0;
  for (const e of h.slice().reverse()) {
    if (e.type !== 'tool_error' || e.code !== TOOL_NOT_FOUND) {
      break;
    }
    if (++n >= 3) {
      return true;
    }
  }
  return false;
}

function detectNoProgress(h) {
  const calls = h.filter((e) => e.type === 'tool_call').slice(-3);
  if (calls.length < 3) {
    return false;
  }
  const sig = calls.map((e) => `${e.name}|${JSON.stringify(e.args || {})}`);
  return sig.every((s) => s === sig[0]);
}

function detectPingPong(h) {
  const calls = h.filter((e) => e.type === 'tool_call').slice(-6);
  const names = calls.map((e) => e.name);
  if (names.length < 6 || names[0] === names[1]) {
    return false;
  }
  return names.every((n, i) => n === (i % 2 === 0 ? names[0] : names[1]));
}

function detectGenericRepeat(h) {
  const calls = h.filter((e) => e.type === 'tool_call').slice(-5);
  if (calls.length < 5) {
    return false;
  }
  const sig = calls.map((e) => `${e.name}|${JSON.stringify(e.args || {})}`);
  return sig.every((s) => s === sig[0]);
}

function isDeadlocked(h) {
  return detectUnknownRepeat(h) || detectNoProgress(h) || detectPingPong(h) || detectGenericRepeat(h);
}

function toolErrMsg(name, code, msg) {
  return `[TOOL_ERROR name=${name} code=${code}] ${msg || ''}`;
}

async function runOneToolCall(catalog, call, ctx, history) {
  const { name, args = {}, id } = call;
  const { turn, sleep, signal } = ctx;
  history.push({ type: 'tool_call', name, args, turn });
  const callCtx = { signal, _sleep: sleep };
  let primary;
  try {
    primary = await retryWithBackoff(async () => {
      const r = await callTool(catalog, name, args, callCtx);
      if (!r.ok && classifyError(r) === 'NETWORK') {
        throw Object.assign(new Error(r.error || 'net'), { errorCode: r.errorCode });
      }
      return r;
    }, { maxAttempts: MR, baseMs: RB, jitter: RJ, sleep });
  } catch (e) {
    primary = { ok: false, errorCode: e.errorCode || TIMEOUT, error: e.message };
  }
  let final = primary;
  if (primary && !primary.ok && classifyError(primary) === 'PERMANENT') {
    const fb = await tryFallbackChain(catalog, name, args, callCtx);
    if (fb && fb.value) {
      final = { ok: true, result: fb.value, via: fb.via };
    } else if (fb && fb.exhausted) {
      final = { ...primary, error: `fallback exhausted for '${name}': ${primary.error || ''}` };
    }
  }
  if (final.ok) {
    history.push({ type: 'tool_result', name, value: final.result, turn });
    return {
      yieldEv: { type: 'tool_result', name, result: final.result, via: final.via, turn },
      msg: { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true, result: final.result, via: final.via }) },
    };
  }
  history.push({ type: 'tool_error', name, args, code: final.errorCode, turn });
  return {
    yieldEv: { type: 'tool_error', name, code: final.errorCode, error: final.error, turn },
    msg: { role: 'tool', tool_call_id: id, content: toolErrMsg(name, final.errorCode, final.error) },
  };
}

async function safeLlmCall(llmCall, live, turn, catalog) {
  try {
    return { resp: await llmCall(live, { turn, catalog }), err: null };
  } catch (e) {
    return { resp: null, err: e };
  }
}

function assistantMsg(calls) {
  return {
    role: 'assistant',
    tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
  };
}

async function processOneTurn(p) {
  const { resp, err } = await safeLlmCall(p.llmCall, p.live, p.turn, p.catalog);
  if (err) {
    p.out.ok = false;
    p.out.errorCode = 'LLM_ERROR';
    return { done: true, events: [{ type: 'llm_error', error: err.message || String(err), turn: p.turn }] };
  }
  const calls = Array.isArray(resp && resp.toolCalls) ? resp.toolCalls : [];
  if (calls.length === 0) {
    const content = (resp && resp.content) || '';
    p.out.content = content;
    return { done: true, events: [{ type: 'text', text: content, turn: p.turn }] };
  }
  const events = [];
  for (const call of calls) {
    const r = await runOneToolCall(p.catalog, call, { turn: p.turn, sleep: p.sleep, signal: p.signal }, p.history);
    events.push(r.yieldEv);
    p.live.push(r.msg);
  }
  if (isDeadlocked(p.history)) {
    p.out.ok = false;
    p.out.errorCode = 'DEADLOCK';
    return { done: true, events: [...events, { type: 'deadlock_detected', turn: p.turn }] };
  }
  p.live.push(assistantMsg(calls));
  return { done: false, events };
}

// Main async generator — never throws to caller.
export async function* toolLoop({ messages, catalog, llmCall, opts = {} }) {
  const maxTurns = resolveMaxTurns(opts.profileCandidateCount || 1);
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = { ok: true, content: null, turns: 0, history: [] };
  const history = [];
  try {
    let turn = 0;
    const live = Array.isArray(messages) ? messages.slice() : [];
    while (turn < maxTurns) {
      turn += 1;
      out.turns = turn;
      const r = await processOneTurn({ turn, live, history, sleep, signal: opts.signal, catalog, llmCall, out });
      for (const ev of r.events) {
        yield ev;
      }
      if (r.done) {
        out.history = history;
        return out;
      }
    }
    yield { type: 'max_turns_exceeded', turns: maxTurns };
    out.ok = false;
    out.errorCode = 'MAX_TURNS_EXCEEDED';
    out.history = history;
    return out;
  } catch (e) {
    out.ok = false;
    out.errorCode = 'LOOP_CRASHED';
    out.error = e.message || String(e);
    out.history = history;
    return out;
  }
}

export const _internal = { isDeadlocked, detectUnknownRepeat, detectNoProgress, detectPingPong, detectGenericRepeat, jitter };
