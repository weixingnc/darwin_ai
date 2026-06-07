/**
 * darwin repl — persistent chat with memory-backed history.
 *
 * Reads conversation history from memory key 'darwin-repl-history', appends each
 * turn, persists after each assistant reply. On next REPL start, history is
 * restored — multi-session continuity for free.
 *
 * Context assembly delegated to core/context-loader.js (5-layer model:
 * identity + personality + learnings + history + this turn). Re-running the
 * loader per turn lets live `darwin memory set` changes take effect
 * immediately without restart.
 *
 * Commands inside REPL:
 *   <text>      — send to provider
 *   clear       — wipe history
 *   exit|quit   — leave REPL
 *   Ctrl+D      — leave REPL
 *
 * MVP scope: no tab-completion, no arrow history, no syntax highlight.
 * Darwin v3 启动期 can layer those on.
 */

import { createInterface } from 'node:readline';
import { sharedBootstrap } from './_shared.js';
import { loadContext } from '../../core/context-loader.js';

const HISTORY_KEY = 'darwin-repl-history';
const PERSONALITY_KEY = 'darwin-personality';
const EXIT_NO_PROVIDER = 2;

async function _getPersonalityText(memory) {
  try {
    const v = await memory.get(PERSONALITY_KEY);
    if (typeof v === 'string' && v.trim().length > 0) {
      return v;
    }
    if (v && typeof v === 'object' && typeof v.content === 'string') {
      return v.content;
    }
    return null;
  } catch {
    return null;
  }
}

export async function repl() {
  const { registry, memory } = await sharedBootstrap();

  if (registry.list().length === 0) {
    console.log('⚠ No provider configured. Run: darwin config add provider-anthropic');
    process.exit(EXIT_NO_PROVIDER);
  }

  const provider = registry.list()[0];
  const personality = await _getPersonalityText(memory);
  const identityLine = personality
    ? `   identity: ${personality.split('\n')[0].slice(0, 60)}${personality.length > 60 ? '…' : ''}`
    : '   identity: (unset — run: darwin memory set darwin-personality "你是 Darwin, ...")';
  console.log(`🤖 Darwin REPL — using ${provider.name}`);
  console.log(identityLine);
  console.log('   (Ctrl+D or "exit" to quit, "clear" to wipe history)\n');

  // Load persisted history (default empty if first run).
  // Loader rebuilds the 5-layer context every turn so live personality edits
  // and memory writes take effect on the very next prompt.
  const history = (await memory.get(HISTORY_KEY)) || { messages: [] };
  if (history.messages.length > 0) {
    console.log(`📜 Restored ${history.messages.length} prior messages\n`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });
  rl.prompt();

  rl.on('line', async (raw) => {
    const text = raw.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === 'exit' || text === 'quit') {
      rl.close();
      return;
    }
    if (text === 'clear') {
      history.messages = [];
      await memory.set(HISTORY_KEY, history);
      console.log('🗑 history cleared\n');
      rl.prompt();
      return;
    }

    history.messages.push({ role: 'user', content: text });
    const { systemMessages, meta } = await loadContext({
      memory,
      historyMessages: history.messages,
    });
    const fullMessages = [...systemMessages, ...history.messages];
    const r = await provider.chat(fullMessages);
    if (!r.ok) {
      console.error(`✗ ${r.error?.message || 'chat failed'}\n`);
      // pop the failed user message so history stays clean
      history.messages.pop();
      rl.prompt();
      return;
    }
    history.messages.push({ role: 'assistant', content: r.value.content });
    await memory.set(HISTORY_KEY, history);
    console.log(`\n${provider.name}> ${r.value.content}`);
    if (process.env.DARWIN_DEBUG) {
      console.log(
        `\n   [ctx layers: ${meta.layers.join('+')}, history=${meta.counts.history}, learnings=${meta.counts.learnings}]`,
      );
    }
    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 bye');
    process.exit(0);
  });
}
