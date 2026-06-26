/**
 * darwin chat — single-shot chat via first configured provider.
 * V31: adds --stream flag for SSE-friendly chunked output.
 *
 * Wires: ConfigResolver -> Container -> bootstrap -> ProviderRegistry
 *   -> Anthropic | OpenAI-compatible.
 * Picks the first registered provider; prints reply; exits 0.
 *
 * Output formats (V31):
 *   default:   prints the full reply as one console.log() call, exits 0
 *   --stream:  prints one line per chunk in the shape "chunk:<text>\n",
 *              then "done:\n", then exits 0. Errors print as "error:<msg>\n"
 *              and exit 3. The line prefix makes the stream trivially
 *              parseable from any web layer (web/server.js does this in
 *              /api/chat when the client sends Accept: text/event-stream).
 *
 * Exits (default mode):
 *   0  success
 *   1  generic error
 *   2  no provider configured
 *   3  chat failed (r.ok === false)
 *
 * Exits (--stream mode):
 *   0  success (after writing "done:" line)
 *   2  no provider configured (writes "error:..." first)
 *   3  provider error (writes "error:..." first)
 *
 * Repl is intentionally NOT touched here. The repl UX needs the
 * synchronous read-eval loop; streaming within a TTY repl is a
 * different concern (V32+).
 */

import { sharedBootstrap } from './_shared.js';
import { loadContext } from '../../core/context-loader.js';

const EXIT_OK = 0;
const EXIT_NO_PROVIDER = 2;
const EXIT_CHAT_FAIL = 3;

// V47: parse chat flags. --messages <JSON> lets callers pass a full
// multi-turn messages array (V47 forward); the legacy positional
// `message` arg is still accepted for single-turn callers (web V45.1
// still uses this path, as does the CLI `darwin chat "hi"` shortcut).
function parseChatFlags(argv) {
  const out = { stream: false, help: false, messageParts: [], messagesJson: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      // Unix convention: --help short-circuits the rest of the argv
      // so callers can run `darwin chat --help --stream foo` and still
      // see the help text. The handler in chat() exits 0 immediately
      // after seeing help=true.
      return out;
    }
    if (a === '--stream') {
      out.stream = true;
      continue;
    }
    if (a === '--no-stream') {
      out.stream = false;
      continue;
    }
    if (a === '--messages') {
      const next = argv[i + 1];
      if (typeof next !== 'string') {
        throw new Error('chat: --messages expects a JSON string argument');
      }
      out.messagesJson = next;
      i += 1;
      continue;
    }
    out.messageParts.push(a);
  }
  return out;
}

// V47: convert the parsed flag bag into a normalized messages array
// [{role, content}, ...] ready for the provider. Throws on malformed
// input so the caller (web/server.js or CLI) can surface a 400 / error.
// Backward compat: if `--messages` is absent, wrap the positional
// text into a single-user message.
function normalizeTurn(m, i) {
  if (!m || typeof m !== 'object') {
    throw new Error('chat: --messages[' + i + '] is not an object');
  }
  const role = m.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new Error('chat: --messages[' + i + '].role must be one of system|user|assistant|tool');
  }
  const content = m.content === null || m.content === undefined ? '' : String(m.content);
  if (role !== 'tool' && content.length === 0) {
    throw new Error('chat: --messages[' + i + '].content is required');
  }
  const out = { role, content };
  if (m.name) {
    out.name = String(m.name);
  }
  if (m.tool_call_id) {
    out.tool_call_id = String(m.tool_call_id);
  }
  return out;
}

function parseMessagesJson(raw) {
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error('chat: --messages is not valid JSON: ' + e.message);
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('chat: --messages must be a non-empty array');
  }
  return arr.map(normalizeTurn);
}

function resolveMessages(flags) {
  if (flags.messagesJson !== null) {
    return parseMessagesJson(flags.messagesJson);
  }
  const text = flags.messageParts.join(' ').trim();
  if (!text) {
    throw new Error('chat: missing message text. Usage: darwin chat "hello"');
  }
  return [{ role: 'user', content: text }];
}

const HELP = `darwin chat -- single-shot chat (V31, optional --stream; V47 multi-turn)

Usage:
  darwin chat "hello"                          print the full reply, exit 0
  darwin chat --stream "hello"                 print "chunk:<text>" lines + "done:", exit 0
  darwin chat --messages '<json>'              multi-turn (V47): array of {role, content}
  darwin chat --messages '<json>' --stream     multi-turn streamed
  darwin chat --help                           show this help

The --stream mode is used by web/server.js to forward provider chunks
to the browser via Server-Sent Events. The line prefix is stable:
  "chunk:<text>\\n"   one or more lines, in arrival order
  "reasoning:<json>\\n"  V46: separate channel for collapsible thinking panel
  "done:\\n"          exactly one line, just before exit 0
  "error:<msg>\\n"    exactly one line on failure (exit 3)

V47 --messages JSON shape:
  [{"role":"system","content":"..."},
   {"role":"user","content":"..."},
   {"role":"assistant","content":"..."}]
Roles allowed: system | user | assistant | tool.
The system prompt from memory is added before your messages.
`;

export async function chat(argv = []) {
  const flags = parseChatFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  const messages = resolveMessages(flags);

  const { registry, memory } = await sharedBootstrap();
  if (registry.list().length === 0) {
    const msg = 'No provider configured. Run: darwin config add provider-anthropic';
    if (flags.stream) {
      process.stdout.write('error:' + msg + '\n');
    } else {
      console.log('\u26a0 ' + msg);
    }
    process.exit(EXIT_NO_PROVIDER);
  }

  const provider = registry.list()[0];
  if (flags.stream) {
    // Stream mode: no banner (we want each stdout line to be a chunk or
    // a control message). The web UI shows its own provider name in the
    // response metadata.
    await streamChat(provider, memory, messages);
    return EXIT_OK;
  }

  // Default mode: provider name banner (V45.1: now on stderr) + full
  // reply. Before V45.1 the banner was on stdout, which meant
  // web/server.js#chatOnce (which captures the full child stdout as the
  // user-visible reply) leaked `🤖 Using openai-compatible\n` into the
  // UI. stderr is the right place for operator-visible logs; stdout is
  // reserved for the user-visible content.
  console.error(`\u{1F916} Using ${provider.name}`);

  // V47: messages is the full turn array (V46 single-user or V47
  // multi-turn). System prompt is added by streamChat/chatOnce via
  // loadContext(); here we just call the provider directly.
  const { systemMessages } = await loadContext({ memory, historyMessages: messages.slice(0, -1) });
  const fullMessages = [...systemMessages, ...messages];

  const r = await provider.chat(fullMessages);

  if (!r.ok) {
    console.error(`\u2717 ${r.error?.message || 'chat failed'}`);
    process.exit(EXIT_CHAT_FAIL);
  }

  // V45.1: process.stdout.write (not console.log) so the reply is
  // emitted verbatim without a leading 'undefined' or extra wrapping.
  // A trailing \n keeps POSIX-friendly line discipline for shell pipes.
  process.stdout.write(r.value.content + '\n');
  return EXIT_OK;
}

/**
 * V45.1: emit a single chunk line for the current accumulated visible
 * content, comparing against `lastContent` and emitting only the delta.
 * Returns the new lastContent. The text is JSON-encoded so any embedded
 * \n survives a single-line frame intact (web/server.js#streamChat
 * decodes the same way). Extracted from streamChat to keep the parent
 * function under the ESLint complexity=15 cap.
 *
 * Edge case: when ev.content shrank (e.g. a <think> block just closed
 * and stripped the leading reasoning), the protocol's accumulator
 * effectively rewinds; we re-baseline lastContent to the new value
 * without emitting so the next non-shrinking delta goes through
 * normally.
 */
function emitContentDelta(lastContent, ev) {
  if (typeof ev.content !== 'string' || ev.content.length === 0) {
    return lastContent;
  }
  if (ev.content.length > lastContent.length) {
    const delta = ev.content.slice(lastContent.length);
    if (delta.length > 0) {
      process.stdout.write('chunk:' + JSON.stringify(delta) + '\n');
    }
    return ev.content;
  }
  // Shrink: just re-baseline, no emit.
  return ev.content;
}

/**
 * V46: same shape as emitContentDelta but for the reasoning channel.
 * Emits a separate "reasoning:<json>" line so the web layer can render
 * it as a collapsible thinking panel (Cursor / ChatGPT style). Reasoning
 * arrives from two sources on OpenAI-compatible R1-family models:
 *   1. delta.reasoning_content (API-level side field, see V45 commit)
 *   2. inline <think>...</think> in delta.content, peeled out by
 *      splitThinkBlocks and accumulated in state.reasoning
 * Both are summed in ev.reasoning and emitted as one delta stream here.
 * Returns the new lastReasoning baseline.
 */
function emitReasoningDelta(lastReasoning, ev) {
  if (typeof ev.reasoning !== 'string' || ev.reasoning.length === 0) {
    return lastReasoning;
  }
  if (ev.reasoning.length > lastReasoning.length) {
    const delta = ev.reasoning.slice(lastReasoning.length);
    if (delta.length > 0) {
      process.stdout.write('reasoning:' + JSON.stringify(delta) + '\n');
    }
    return ev.reasoning;
  }
  // Shrink: re-baseline only.
  return ev.reasoning;
}

async function streamChat(provider, memory, messages) {
  // V47: messages is now an array of {role, content}; legacy callers
  // (and tests) can still pass a string, which we wrap as a single
  // user turn -- the same surface streamChat always exposed.
  const turns = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
  // V47: pass everything before the last user turn as history so
  // loadContext() can weave prior assistant replies into the system
  // context (memory layer is aware of history turns).
  const historyMessages = turns.length > 1 ? turns.slice(0, -1) : [];
  const { systemMessages } = await loadContext({ memory, historyMessages });
  const fullMessages = [...systemMessages, ...turns];

  // ProviderBase.stream() may not be implemented by every provider; we
  // fall back to chat() and emit the full reply as a single chunk, so
  // the V31 line-prefix contract still holds.
  if (typeof provider.stream !== 'function') {
    const r = await provider.chat(fullMessages);
    if (r.ok) {
      process.stdout.write('chunk:' + r.value.content + '\n');
      process.stdout.write('done:\n');
      return;
    }
    process.stdout.write('error:' + (r.error?.message || 'chat failed') + '\n');
    process.exit(EXIT_CHAT_FAIL);
  }

  let hadError = false;
  let lastContent = '';
  let lastReasoning = '';
  try {
    for await (const ev of provider.stream(fullMessages)) {
      if (!ev) {
        continue;
      }
      if (ev.type === 'done') {
        break;
      }
      if (ev.type === 'error') {
        hadError = true;
        const msg = ev.error?.message || 'stream error';
        process.stdout.write('error:' + msg + '\n');
        break;
      }
      // Snapshot event (V45 contract): { content, reasoning, toolCalls,
      // finishReason, raw }. Emit the delta vs the previously-seen
      // visible content, plus a separate reasoning channel for the
      // collapsible thinking panel (V46).
      lastContent = emitContentDelta(lastContent, ev);
      lastReasoning = emitReasoningDelta(lastReasoning, ev);
    }
  } catch (e) {
    hadError = true;
    process.stdout.write('error:' + (e?.message || String(e)) + '\n');
  }

  if (hadError) {
    process.exit(EXIT_CHAT_FAIL);
  }
  process.stdout.write('done:\n');
}

// V47: exported for unit tests so we can drive parseChatFlags /
// resolveMessages without spawning the bin/darwin child. Internal
// callers in this module use the same surfaces directly.
export const _internal = {
  parseChatFlags,
  resolveMessages,
};
