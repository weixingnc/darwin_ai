// tests/core/tool-loop.test.js — PR-25 (≥8 unit + ≥4 integration per design §PR-25)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolLoop,
  classifyError,
  retryWithBackoff,
  MAX_TURNS,
  resolveMaxTurns,
  TOOL_ERROR_CODES,
} from '../../core/tool-loop.js';
import { createCatalog, registerTool } from '../../core/tool-catalog.js';

const ns = () => Promise.resolve();
const mk = (n, o = {}) => ({
  name: n,
  parameters: o.parameters || { type: 'object', properties: {} },
  execute: o.execute || (async () => `ok:${n}`),
  fallback: o.fallback || [],
});
async function run(cat, llm, msgs = []) {
  const out = [];
  const opts = { sleep: ns };
  for await (const e of toolLoop({ messages: msgs, catalog: cat, llmCall: llm, opts })) {
    out.push(e);
  }
  return out;
}

describe('tool-loop: unit', () => {
  test('classifyError 3-state', () => {
    assert.equal(classifyError({ errorCode: 'TOOL_INVALID_ARGS' }), 'RECOVERABLE');
    assert.equal(classifyError({ errorCode: 'TIMEOUT' }), 'NETWORK');
    assert.equal(classifyError({ errorCode: 'TOOL_EXEC_FAILED' }), 'PERMANENT');
    assert.equal(classifyError({ errorCode: 'TOOL_NOT_FOUND' }), 'PERMANENT');
    assert.equal(classifyError(new Error('missing required x')), 'RECOVERABLE');
    assert.equal(classifyError(new Error('ECONNRESET')), 'NETWORK');
    assert.equal(classifyError(new Error('429 rate limit')), 'NETWORK');
    assert.equal(classifyError(new Error('other')), 'PERMANENT');
  });
  test('MAX_TURNS const + resolveMaxTurns (24+8n, 32..160)', () => {
    assert.equal(resolveMaxTurns(1), 32);
    assert.equal(resolveMaxTurns(2), 40);
    assert.equal(resolveMaxTurns(0), 32);
    assert.equal(resolveMaxTurns(100), 160);
    assert.equal(MAX_TURNS, 32);
  });
  test('TOOL_ERROR_CODES has 4 codes', () => {
    assert.equal(Object.keys(TOOL_ERROR_CODES).length, 4);
    for (const k of ['TIMEOUT', 'TOOL_EXEC_FAILED', 'TOOL_INVALID_ARGS', 'TOOL_NOT_FOUND']) {
      assert.ok(TOOL_ERROR_CODES[k], k);
    }
  });
  test('1 round, no tool call → text + done', async () => {
    const e = await run(createCatalog(), async () => ({ content: 'hi' }));
    assert.equal(e.length, 1);
    assert.equal(e[0].type, 'text');
    assert.equal(e[0].text, 'hi');
  });
  test('multi-round tool call accumulates messages', async () => {
    const c = createCatalog();
    registerTool(c, mk('echo', { execute: async (a) => a.v }));
    let n = 0;
    const llm = async (m) => (n++ === 0 ? { toolCalls: [{ id: 't1', name: 'echo', args: { v: 'x' } }] } : { content: `d:${m.length}` });
    const e = await run(c, llm, [{ role: 'user', content: 'go' }]);
    assert.equal(e[e.length - 1].type, 'text');
    assert.match(e[e.length - 1].text, /^d:\d+$/);
  });
  test('retryWithBackoff: exp + jitter within ±20%', async () => {
    const sl = [];
    let n = 0;
    const fn = async () => { if (++n < 3) { throw new Error('x'); } return 'ok'; };
    const r = await retryWithBackoff(fn, { maxAttempts: 3, baseMs: 300, jitter: 0.2, sleep: (m) => sl.push(m) });
    assert.equal(r, 'ok');
    assert.equal(sl.length, 2);
    assert.ok(sl[0] >= 240 && sl[0] <= 360, `s0=${sl[0]}`);
    assert.ok(sl[1] >= 480 && sl[1] <= 720, `s1=${sl[1]}`);
  });
  test('deadlock (unknown_tool_repeat) breaks loop', async () => {
    let n = 0;
    const llm = async () => ({ toolCalls: [{ id: `t${++n}`, name: 'ghost', args: {} }] });
    const e = await run(createCatalog(), llm);
    assert.ok(e.some((x) => x.type === 'deadlock_detected'));
  });
  test('RECOVERABLE error does NOT retry (single execution)', async () => {
    const c = createCatalog();
    let calls = 0;
    registerTool(c, mk('strict', { parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, execute: async () => { calls++; throw new Error('invalid argument format'); } }));
    let n = 0;
    const llm = async () => (n++ === 0 ? { toolCalls: [{ id: 'a', name: 'strict', args: { x: 'hi' } }] } : { content: 'ok' });
    await run(c, llm);
    assert.equal(calls, 1);
  });
});

describe('tool-loop: integration', () => {
  test('full chain: messages → tool → result → final', async () => {
    const c = createCatalog();
    registerTool(c, mk('add', { parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] }, execute: async (a) => a.a + a.b }));
    let n = 0;
    const llm = async () => (n++ === 0 ? { toolCalls: [{ id: 'c1', name: 'add', args: { a: 2, b: 3 } }] } : { content: 'sum=5' });
    const e = await run(c, llm, [{ role: 'user', content: '2+3' }]);
    assert.equal(e.length, 2);
    assert.equal(e[0].type, 'tool_result');
    assert.equal(e[0].result, 5);
    assert.equal(e[1].type, 'text');
    assert.equal(e[1].text, 'sum=5');
  });
  test('fallback chain: primary fails → fallback[0] succeeds', async () => {
    const c = createCatalog();
    registerTool(c, mk('prim', { execute: async () => { throw new Error('down'); }, fallback: ['alt1', 'alt2'] }));
    registerTool(c, mk('alt1', { execute: async () => 'from-alt1' }));
    registerTool(c, mk('alt2', { execute: async () => 'from-alt2' }));
    let n = 0;
    const llm = async () => (n++ === 0 ? { toolCalls: [{ id: 'f', name: 'prim', args: {} }] } : { content: 'got' });
    const e = await run(c, llm);
    const r = e.find((x) => x.type === 'tool_result');
    assert.ok(r);
    assert.equal(r.result, 'from-alt1');
    assert.equal(r.via, 'alt1');
  });
  test('TIMEOUT retry: 1st fails ECONNRESET, 2nd succeeds', async () => {
    const c = createCatalog();
    let n = 0;
    registerTool(c, mk('flaky', { execute: async () => { if (++n < 2) { throw Object.assign(new Error('ECONNRESET'), { errorCode: 'TIMEOUT' }); } return 'recovered'; } }));
    let ln = 0;
    const llm = async () => (ln++ === 0 ? { toolCalls: [{ id: 'r', name: 'flaky', args: {} }] } : { content: 'done' });
    const e = await run(c, llm);
    assert.equal(e.find((x) => x.type === 'tool_result').result, 'recovered');
    assert.equal(n, 2);
  });
  test('4 detectors: ping_pong triggers after A→B→A→B', async () => {
    const c = createCatalog();
    registerTool(c, mk('A', { execute: async () => 'a' }));
    registerTool(c, mk('B', { execute: async () => 'b' }));
    let n = 0;
    const llm = async () => ({ toolCalls: [{ id: `p${++n}`, name: n % 2 === 1 ? 'A' : 'B', args: {} }] });
    const e = await run(c, llm);
    assert.ok(e.some((x) => x.type === 'deadlock_detected'), 'should detect ping_pong');
  });
});
