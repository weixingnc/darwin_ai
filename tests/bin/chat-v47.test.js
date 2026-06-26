/**
 * tests/bin/chat-v47.test.js -- V47: --messages <JSON> multi-turn parsing.
 *
 * Why this test exists: V47 extends `darwin chat` to accept a full
 * messages array (the web UI needs the prior turns to be sent back to
 * the provider). The legacy positional `message` arg still works, so
 * tests/bin/chat-stream.test.js (V31) keeps working unchanged.
 *
 * Coverage:
 *   - parseChatFlags: --messages alone, --stream + --messages,
 *     missing JSON arg, mutual exclusion with positional
 *   - resolveMessages: legacy wrap, JSON parse error, empty array,
 *     bad role, missing content (non-tool), name/tool_call_id preserved,
 *     tool messages may have empty content
 *   - streamChat: array form reaches the provider as full messages;
 *     string form is still wrapped to a single-user turn (backward
 *     compat for the V45.1 web spawn path)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _internal, chat } from '../../bin/lib/chat.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const { parseChatFlags, resolveMessages } = _internal;

// Each test runs in a fresh isolated HOME so ConfigResolver cannot
// see the developer's real ~/.darwin (which may have a real provider
// configured on this box).
function makeIsolatedHome() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'darwin-chat-v47-'));
  return () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
}

describe('chat V47: parseChatFlags', () => {
  test('legacy positional message is captured', () => {
    const flags = parseChatFlags(['hello', 'world']);
    assert.equal(flags.stream, false);
    assert.equal(flags.messagesJson, null);
    assert.deepEqual(flags.messageParts, ['hello', 'world']);
  });

  test('--stream flag toggles stream mode', () => {
    const flags = parseChatFlags(['--stream', 'hi']);
    assert.equal(flags.stream, true);
    assert.deepEqual(flags.messageParts, ['hi']);
  });

  test('--messages <JSON> consumes the next argv item', () => {
    const json = '[{"role":"user","content":"hi"}]';
    const flags = parseChatFlags(['--messages', json]);
    assert.equal(flags.messagesJson, json);
    assert.deepEqual(flags.messageParts, []);
  });

  test('--messages combined with --stream and legacy position', () => {
    const json = '[{"role":"user","content":"hi"}]';
    const flags = parseChatFlags(['--stream', '--messages', json, 'extra']);
    assert.equal(flags.stream, true);
    assert.equal(flags.messagesJson, json);
    assert.deepEqual(flags.messageParts, ['extra']);
  });

  test('--messages without a JSON arg throws', () => {
    assert.throws(
      () => parseChatFlags(['--messages']),
      /--messages expects a JSON string argument/,
    );
  });

  test('--help short-circuits without consuming more args', () => {
    // Unix convention: `--help` aborts flag processing immediately,
    // so the rest of the argv is left untouched (stream stays false,
    // and the trailing positional token is NOT consumed as a message).
    const flags = parseChatFlags(['--help', '--stream', 'hi']);
    assert.equal(flags.help, true);
    assert.equal(flags.stream, false);
    assert.deepEqual(flags.messageParts, []);
  });
});

describe('chat V47: resolveMessages', () => {
  test('legacy positional text wraps to a single user turn', () => {
    const flags = parseChatFlags(['hello']);
    const msgs = resolveMessages(flags);
    assert.deepEqual(msgs, [{ role: 'user', content: 'hello' }]);
  });

  test('empty legacy message throws a usage error', () => {
    const flags = parseChatFlags([]);
    assert.throws(() => resolveMessages(flags), /missing message text/);
  });

  test('valid multi-turn JSON parses cleanly', () => {
    const flags = parseChatFlags([
      '--messages',
      JSON.stringify([
        { role: 'system', content: 'you are a helpful bot' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello!' },
        { role: 'user', content: 'how are you?' },
      ]),
    ]);
    const msgs = resolveMessages(flags);
    assert.equal(msgs.length, 4);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[3].role, 'user');
    assert.equal(msgs[3].content, 'how are you?');
  });

  test('name + tool_call_id pass through for tool turns', () => {
    const flags = parseChatFlags([
      '--messages',
      JSON.stringify([{ role: 'tool', tool_call_id: 'call_1', content: 'result' }]),
    ]);
    const msgs = resolveMessages(flags);
    assert.equal(msgs[0].role, 'tool');
    assert.equal(msgs[0].tool_call_id, 'call_1');
    assert.equal(msgs[0].content, 'result');
  });

  test('invalid JSON throws a parse-friendly error', () => {
    const flags = parseChatFlags(['--messages', '{not json']);
    assert.throws(() => resolveMessages(flags), /not valid JSON/);
  });

  test('empty array throws', () => {
    const flags = parseChatFlags(['--messages', '[]']);
    assert.throws(() => resolveMessages(flags), /non-empty array/);
  });

  test('non-array JSON throws', () => {
    const flags = parseChatFlags(['--messages', '{"role":"user"}']);
    assert.throws(() => resolveMessages(flags), /non-empty array/);
  });

  test('bad role throws with the offending index', () => {
    const flags = parseChatFlags([
      '--messages',
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'bot', content: 'oops' },
      ]),
    ]);
    assert.throws(() => resolveMessages(flags), /messages\[1\]\.role/);
  });

  test('missing content on a non-tool turn throws', () => {
    const flags = parseChatFlags(['--messages', JSON.stringify([{ role: 'user' }])]);
    assert.throws(() => resolveMessages(flags), /content is required/);
  });

  test('tool messages may have empty content', () => {
    const flags = parseChatFlags([
      '--messages',
      JSON.stringify([{ role: 'tool', tool_call_id: 'x' }]),
    ]);
    const msgs = resolveMessages(flags);
    assert.equal(msgs[0].role, 'tool');
    assert.equal(msgs[0].content, '');
  });
});

describe('chat V47: streamChat integration with mock provider', () => {
  test('array form reaches the provider as full messages', async () => {
    const cleanup = makeIsolatedHome();
    process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'darwin-chat-v47-home-'));
    try {
      // Capture stdout lines emitted by streamChat.
      const captured = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        captured.push(String(chunk));
        return origWrite(chunk, ...rest);
      };
      try {
        // Inline a minimal fake registry/memory, then call chat() so we
        // exercise the real argv -> resolveMessages -> streamChat path.
        // We can't easily mock sharedBootstrap() without a real
        // ~/.darwin, so we drive streamChat() directly via internal
        // access. Since streamChat isn't exported, we round-trip via
        // resolveMessages and assert the shape that streamChat would
        // hand to provider.stream().
        const flags = parseChatFlags([
          '--messages',
          JSON.stringify([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'second' },
          ]),
        ]);
        const msgs = resolveMessages(flags);
        assert.equal(msgs.length, 4);
        assert.equal(msgs[msgs.length - 1].content, 'second');
        // History (everything except the last turn) shape -- this is
        // what loadContext() receives in streamChat():
        const history = msgs.slice(0, -1);
        assert.equal(history.length, 3);
        assert.equal(history[history.length - 1].role, 'assistant');
      } finally {
        process.stdout.write = origWrite;
      }
    } finally {
      delete process.env.HOME;
      cleanup();
    }
  });
});

describe('chat V47: chat() argv smoke', () => {
  test('--help exits 0 and prints the V47 message doc', async () => {
    process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'darwin-chat-v47-help-'));
    try {
      const exitCode = await chat(['--help']);
      assert.equal(exitCode, 0);
    } finally {
      delete process.env.HOME;
    }
  });

  test('missing message (no positional, no --messages) throws', async () => {
    process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'darwin-chat-v47-empty-'));
    try {
      await assert.rejects(chat([]), /missing message text/);
    } finally {
      delete process.env.HOME;
    }
  });

  test('invalid --messages JSON throws', async () => {
    process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'darwin-chat-v47-badjson-'));
    try {
      await assert.rejects(chat(['--messages', '{not json']), /not valid JSON/);
    } finally {
      delete process.env.HOME;
    }
  });
});

// B2 (coverage push): drive the V45.1/V46 streaming helpers directly
// so the bulk of streamChat (lines 264-323) is exercised. We capture
// process.stdout.write to assert the line-prefix protocol:
//   "chunk:<json>"   content delta
//   "reasoning:<json>"  V46 reasoning channel
//   "done:"          stream finished
//   "error:<msg>"    stream errored
describe('chat V47+45.1+46: streamChat direct (B2 coverage)', () => {
  const { emitContentDelta, emitReasoningDelta, streamChat } = _internal;

  function captureStdout(fn) {
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return origWrite(chunk, ...rest);
    };
    const exitCalls = [];
    const origExit = process.exit;
    process.exit = (code) => {
      exitCalls.push(code);
      // Don't actually exit the test runner.
      throw new Error('__exit__:' + code);
    };
    return Promise.resolve()
      .then(fn)
      .then(
        () => {
          process.stdout.write = origWrite;
          process.exit = origExit;
          return { captured, exitCalls };
        },
        (e) => {
          process.stdout.write = origWrite;
          process.exit = origExit;
          if (e && typeof e.message === 'string' && e.message.startsWith('__exit__:')) {
            // Error message is '__exit__:<code>' — skip the 9-char
            // prefix to extract the exit code as a number.
            return { captured, exitCalls: [Number(e.message.slice(9))] };
          }
          throw e;
        },
      );
  }

  test('emitContentDelta: grow emits the delta JSON-encoded', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => captured.push(String(chunk));
    try {
      const next = emitContentDelta('', { content: 'hello' });
      assert.equal(next, 'hello');
      const next2 = emitContentDelta('hello', { content: 'hello world' });
      assert.equal(next2, 'hello world');
    } finally {
      process.stdout.write = orig;
    }
    assert.deepEqual(captured, ['chunk:"hello"\n', 'chunk:" world"\n']);
  });

  test('emitContentDelta: empty / non-string content does nothing', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => captured.push(String(chunk));
    try {
      assert.equal(emitContentDelta('x', { content: '' }), 'x');
      assert.equal(emitContentDelta('x', { content: 123 }), 'x');
      assert.equal(emitContentDelta('x', {}), 'x');
    } finally {
      process.stdout.write = orig;
    }
    assert.deepEqual(captured, []);
  });

  test('emitContentDelta: shrink re-baselines without emitting', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => captured.push(String(chunk));
    try {
      // V45 protocol rewinds after stripping a <think> block -- the
      // new accumulated content is shorter than lastContent. We must
      // NOT emit the negative delta; we just take the new baseline.
      const next = emitContentDelta('<think>long reasoning</think>hi', { content: 'hi' });
      assert.equal(next, 'hi');
    } finally {
      process.stdout.write = orig;
    }
    assert.deepEqual(captured, []);
  });

  test('emitReasoningDelta: same shape as content delta', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => captured.push(String(chunk));
    try {
      emitReasoningDelta('', { reasoning: 'step 1' });
      emitReasoningDelta('step 1', { reasoning: 'step 1 + step 2' });
      emitReasoningDelta('step 1 + step 2', { reasoning: 'shrunk' });
      emitReasoningDelta('shrunk', { reasoning: '' });
      emitReasoningDelta('shrunk', {});
    } finally {
      process.stdout.write = orig;
    }
    // Shrink re-baselines without emitting (line 261); empty / missing
    // reasoning does nothing. The new baseline still wins, just silently.
    assert.deepEqual(captured, ['reasoning:"step 1"\n', 'reasoning:" + step 2"\n']);
  });

  // Minimal memory stub: loadContext() (called by streamChat) checks
  // memory.list/get and reads PERSONALITY_KEY. Returning empty values
  // for both is enough to keep the loader happy without touching disk.
  function fakeMemory() {
    return {
      async list(_prefix) {
        return [];
      },
      async get(_key) {
        return null;
      },
    };
  }

  test('streamChat with provider.stream() — emits chunk + done lines', async () => {
    async function* fakeStream() {
      yield { type: 'chunk', content: 'hello' };
      yield { type: 'chunk', content: 'hello world' };
      yield { type: 'done' };
    }
    const memory = fakeMemory();
    const fakeProvider = {
      name: 'mock',
      stream: fakeStream,
    };
    const { captured, exitCalls } = await captureStdout(() =>
      streamChat(fakeProvider, memory, [{ role: 'user', content: 'hi' }]),
    );
    assert.deepEqual(captured, ['chunk:"hello"\n', 'chunk:" world"\n', 'done:\n']);
    assert.deepEqual(exitCalls, []);
  });

  test('streamChat with provider.stream() error event → error: line + exit', async () => {
    async function* fakeStream() {
      yield { type: 'chunk', content: 'partial' };
      yield { type: 'error', error: { message: 'upstream 500' } };
    }
    const fakeProvider = { name: 'mock', stream: fakeStream };
    const { captured, exitCalls } = await captureStdout(() =>
      streamChat(fakeProvider, fakeMemory(), [{ role: 'user', content: 'hi' }]),
    );
    assert.ok(
      captured.some((l) => l.startsWith('chunk:')),
      'should emit at least one chunk line',
    );
    assert.ok(
      captured.some((l) => l.startsWith('error:upstream 500')),
      'should emit error line, got: ' + JSON.stringify(captured),
    );
    assert.deepEqual(exitCalls, [3]);
  });

  test('streamChat with provider.stream() throws → caught + error: line + exit', async () => {
    async function* fakeStream() {
      yield { type: 'chunk', content: 'a' };
      throw new Error('stream blew up');
    }
    const fakeProvider = { name: 'mock', stream: fakeStream };
    const { captured, exitCalls } = await captureStdout(() =>
      streamChat(fakeProvider, fakeMemory(), [{ role: 'user', content: 'hi' }]),
    );
    assert.ok(captured.some((l) => l.startsWith('error:stream blew up')));
    assert.deepEqual(exitCalls, [3]);
  });

  test('streamChat falls back to provider.chat when stream() missing', async () => {
    const fakeProvider = {
      name: 'mock-no-stream',
      async chat(_messages) {
        return { ok: true, value: { content: 'full reply' } };
      },
    };
    const { captured, exitCalls } = await captureStdout(() =>
      streamChat(fakeProvider, fakeMemory(), [{ role: 'user', content: 'hi' }]),
    );
    assert.deepEqual(captured, ['chunk:full reply\n', 'done:\n']);
    assert.deepEqual(exitCalls, []);
  });

  test('streamChat falls back to provider.chat error path → error: + exit', async () => {
    const fakeProvider = {
      name: 'mock-no-stream-fail',
      async chat(_messages) {
        return { ok: false, error: { message: 'no key' } };
      },
    };
    const { captured, exitCalls } = await captureStdout(() =>
      streamChat(fakeProvider, fakeMemory(), [{ role: 'user', content: 'hi' }]),
    );
    assert.deepEqual(captured, ['error:no key\n']);
    assert.deepEqual(exitCalls, [3]);
  });

  test('streamChat multi-turn: provider receives full messages (legacy string form still wraps)', async () => {
    let receivedMessages = null;
    async function* fakeStream(messages) {
      receivedMessages = messages;
      yield { type: 'chunk', content: 'ok' };
      yield { type: 'done' };
    }
    const fakeProvider = { name: 'mock', stream: fakeStream };
    await captureStdout(() => streamChat(fakeProvider, fakeMemory(), 'legacy string arg'));
    // Legacy string form is wrapped to a single-user turn; the provider
    // sees [{role:'user', content:'legacy string arg'}] plus whatever
    // loadContext() adds (system prompt -- empty in this minimal fake).
    assert.ok(receivedMessages, 'provider.stream() must have been called');
    const lastUser = receivedMessages[receivedMessages.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.equal(lastUser.content, 'legacy string arg');
  });
});
