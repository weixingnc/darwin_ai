/**
 * Tool-call protocol layer tests — TDD red→green for PR 7.
 *
 * THE critical test file: v1 飞书 tool-call bug 6 root causes MUST be
 * covered here. See docs/ANTI_PATTERNS.md (D-1/2/3).
 *
 * The 6 v1 root causes (and how v2 fixes them):
 *  1. tool_calls format wrong (each toolCall separately pushed) — TEST: 1 assistant + N role:tool
 *  2. tool_call_id not echoed back                    — TEST: tool_call_id preserved
 *  3. no MAX_TOOL_ROUNDS=5 limit                      — TEST: constant + validate
 *  4. tool throws break round                        — TEST: try/catch, never throws
 *  5. no finish_reason log                           — TEST: console.log emitted
 *  6. no stop_reason log                             — TEST: console.log emitted (anthropic)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallProtocol,
  MAX_TOOL_ROUNDS,
  formatToolCalls,
  parseAssistantToolCalls,
  buildToolResultMessage,
} from '../provider/protocol/tool-call.js';

describe('ToolCallProtocol — v1 飞书 bug root cause #1: 1 assistant + N role:tool', () => {
  test('formatToolCalls: 3 toolCalls → 1 assistant message + 3 role:tool messages (in order)', () => {
    const toolCalls = [
      { id: 'call_1', name: 'a', arguments: '{"q":1}' },
      { id: 'call_2', name: 'b', arguments: '{"q":2}' },
      { id: 'call_3', name: 'c', arguments: '{"q":3}' },
    ];
    const results = ['res1', 'res2', 'res3'];
    const out = formatToolCalls(toolCalls, results);
    // exactly 4 messages
    assert.equal(out.length, 4);
    // message 0: assistant with ALL toolCalls
    assert.equal(out[0].role, 'assistant');
    assert.deepEqual(out[0].tool_calls, toolCalls);
    // messages 1-3: role:tool in matching order
    for (let i = 0; i < 3; i++) {
      assert.equal(out[1 + i].role, 'tool');
      assert.equal(out[1 + i].tool_call_id, toolCalls[i].id);
      assert.equal(out[1 + i].content, results[i]);
    }
  });

  test('v1 ANTI-PATTERN: each toolCall pushed separately is REJECTED by this layer', () => {
    // The buggy v1 pattern was: messages.push({role:'assistant', tool_calls:[tc]}); per toolCall.
    // formatToolCalls MUST consolidate to a single assistant message even when called naively.
    const toolCalls = [
      { id: 'x', name: 'a', arguments: '{}' },
      { id: 'y', name: 'b', arguments: '{}' },
    ];
    const out = formatToolCalls(toolCalls, ['r1', 'r2']);
    const assistantCount = out.filter((m) => m.role === 'assistant').length;
    assert.equal(assistantCount, 1, 'must consolidate to exactly 1 assistant message');
  });
});

describe('ToolCallProtocol — v1 飞书 bug root cause #2: tool_call_id 回传', () => {
  test('buildToolResultMessage preserves tool_call_id verbatim', () => {
    const tc = { id: 'call_abc_123', name: 'search', arguments: '{}' };
    const msg = buildToolResultMessage(tc, '{"hits":[]}');
    assert.equal(msg.role, 'tool');
    assert.equal(msg.tool_call_id, 'call_abc_123');
    assert.equal(msg.content, '{"hits":[]}');
  });

  test('formatToolCalls with mixed id formats preserves each id', () => {
    const toolCalls = [
      { id: 'call_xyz', name: 'a', arguments: '{}' },
      { id: 'toolu_01ABC', name: 'b', arguments: '{}' },
    ];
    const out = formatToolCalls(toolCalls, ['1', '2']);
    assert.equal(out[1].tool_call_id, 'call_xyz');
    assert.equal(out[2].tool_call_id, 'toolu_01ABC');
  });
});

describe('ToolCallProtocol — v1 飞书 bug root cause #3: MAX_TOOL_ROUNDS=5', () => {
  test('MAX_TOOL_ROUNDS constant is exported and equals 5', () => {
    assert.equal(typeof MAX_TOOL_ROUNDS, 'number');
    assert.equal(MAX_TOOL_ROUNDS, 5);
  });

  test('formatToolCalls throws RangeError when toolCalls length exceeds MAX_TOOL_ROUNDS', () => {
    const toolCalls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: 'n',
      arguments: '{}',
    }));
    const results = toolCalls.map(() => 'r');
    assert.throws(() => formatToolCalls(toolCalls, results), /MAX_TOOL_ROUNDS/);
  });

  test('formatToolCalls accepts exactly MAX_TOOL_ROUNDS toolCalls', () => {
    const toolCalls = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: 'n',
      arguments: '{}',
    }));
    const results = toolCalls.map(() => 'r');
    const out = formatToolCalls(toolCalls, results);
    assert.equal(out.length, 6); // 1 assistant + 5 tool
  });
});

describe('ToolCallProtocol — v1 飞书 bug root cause #4: try/catch, never throws to caller', () => {
  test('parseAssistantToolCalls with malformed input returns empty toolCalls (never throws)', () => {
    assert.deepEqual(parseAssistantToolCalls(null), []);
    assert.deepEqual(parseAssistantToolCalls(undefined), []);
    assert.deepEqual(parseAssistantToolCalls({}), []);
    assert.deepEqual(parseAssistantToolCalls({ role: 'assistant' }), []);
    assert.deepEqual(parseAssistantToolCalls('not-an-object'), []);
    assert.deepEqual(parseAssistantToolCalls(42), []);
  });

  test('formatToolCalls with mismatched results length returns safe fallback (never throws)', () => {
    const toolCalls = [{ id: 'a', name: 'n', arguments: '{}' }];
    // results is shorter than toolCalls — must not throw
    const out = formatToolCalls(toolCalls, []);
    assert.equal(out.length, 2);
    assert.equal(out[1].content, '');
  });
});

describe('ToolCallProtocol — v1 飞书 bug root causes #5/#6: finish_reason / stop_reason logs', () => {
  let logs;
  let origLog;
  beforeEach(() => {
    origLog = console.log;
    logs = [];
    console.log = (...args) => logs.push(args.join(' '));
  });
  afterEach(() => {
    console.log = origLog;
  });

  test('logFinishReason emits a log line containing the reason', () => {
    const proto = new ToolCallProtocol();
    proto.logFinishReason('stop', { openai: true });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /finish_reason/i);
    assert.match(logs[0], /stop/);
  });

  test('logStopReason emits a log line containing the reason (anthropic-style)', () => {
    const proto = new ToolCallProtocol();
    proto.logStopReason('end_turn', { anthropic: true });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /stop_reason/i);
    assert.match(logs[0], /end_turn/);
  });

  test('logFinishReason does not throw on undefined/null reason', () => {
    const proto = new ToolCallProtocol();
    assert.doesNotThrow(() => proto.logFinishReason(undefined));
    assert.doesNotThrow(() => proto.logFinishReason(null));
  });
});

describe('ToolCallProtocol — boundary cases', () => {
  test('empty toolCalls → empty array (no assistant, no tool messages)', () => {
    assert.deepEqual(formatToolCalls([], []), []);
  });

  test('parseAssistantToolCalls extracts toolCalls from valid assistant message', () => {
    const msg = {
      role: 'assistant',
      tool_calls: [
        { id: 'c1', name: 'a', arguments: '{"x":1}' },
        { id: 'c2', name: 'b', arguments: '{}' },
      ],
    };
    const tcs = parseAssistantToolCalls(msg);
    assert.equal(tcs.length, 2);
    assert.equal(tcs[0].id, 'c1');
    assert.equal(tcs[1].name, 'b');
  });

  test('parseAssistantToolCalls returns empty when tool_calls is missing', () => {
    assert.deepEqual(parseAssistantToolCalls({ role: 'assistant', content: 'no tools' }), []);
  });

  test('tool result with nested cause is serialized as JSON in content', () => {
    const tc = { id: 'c1', name: 'n', arguments: '{}' };
    const result = { ok: true, data: [1, 2, 3], cause: { source: 'internal' } };
    const msg = buildToolResultMessage(tc, result);
    assert.equal(msg.role, 'tool');
    assert.equal(msg.tool_call_id, 'c1');
    // content must be a string (serialized), not the object
    assert.equal(typeof msg.content, 'string');
    assert.match(msg.content, /cause/);
  });
});
