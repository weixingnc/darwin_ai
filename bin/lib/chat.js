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

function parseChatFlags(argv) {
  const out = { stream: false, help: false, messageParts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--stream') {
      out.stream = true;
      continue;
    }
    if (a === '--no-stream') {
      out.stream = false;
      continue;
    }
    out.messageParts.push(a);
  }
  return out;
}

const HELP = `darwin chat -- single-shot chat (V31, optional --stream)

Usage:
  darwin chat "hello"               print the full reply, exit 0
  darwin chat --stream "hello"      print "chunk:<text>" lines + "done:", exit 0
  darwin chat --help                show this help

The --stream mode is used by web/server.js to forward provider chunks
to the browser via Server-Sent Events. The line prefix is stable:
  "chunk:<text>\\n"   one or more lines, in arrival order
  "done:\\n"          exactly one line, just before exit 0
  "error:<msg>\\n"    exactly one line on failure (exit 3)
`;

export async function chat(argv = []) {
  const flags = parseChatFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  const text = flags.messageParts.join(' ').trim();
  if (!text) {
    throw new Error('chat: missing message text. Usage: darwin chat "hello"');
  }

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
    await streamChat(provider, memory, text);
    return EXIT_OK;
  }

  // Default mode: banner + full reply (V23 behavior).
  console.log(`\u{1F916} Using ${provider.name}\n`);

  const { systemMessages } = await loadContext({ memory, historyMessages: [] });
  const fullMessages = [...systemMessages, { role: 'user', content: text }];

  const r = await provider.chat(fullMessages);

  if (!r.ok) {
    console.error(`\u2717 ${r.error?.message || 'chat failed'}`);
    process.exit(EXIT_CHAT_FAIL);
  }

  console.log(r.value.content);
  return EXIT_OK;
}

async function streamChat(provider, memory, text) {
  const { systemMessages } = await loadContext({ memory, historyMessages: [] });
  const fullMessages = [...systemMessages, { role: 'user', content: text }];

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
      // Snapshot event: { content, toolCalls, finishReason, raw }
      // We emit the accumulated content as one chunk per snapshot.
      // The browser will dedupe / smooth via the SSE event stream.
      if (typeof ev.content === 'string' && ev.content.length > 0) {
        process.stdout.write('chunk:' + ev.content + '\n');
      }
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
