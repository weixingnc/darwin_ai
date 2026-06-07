/**
 * darwin repl — persistent chat with memory-backed history.
 *
 * Reads conversation history from memory key 'darwin-repl-history', appends each
 * turn, persists after each assistant reply. On next REPL start, history is
 * restored — multi-session continuity for free.
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

const HISTORY_KEY = 'darwin-repl-history';
const EXIT_NO_PROVIDER = 2;

export async function repl() {
  const { registry, memory } = await sharedBootstrap();

  if (registry.list().length === 0) {
    console.log('⚠ No provider configured. Run: darwin config add provider-anthropic');
    process.exit(EXIT_NO_PROVIDER);
  }

  const provider = registry.list()[0];
  console.log(`🤖 Darwin REPL — using ${provider.name}`);
  console.log('   (Ctrl+D or "exit" to quit, "clear" to wipe history)\n');

  // Load persisted history (default empty if first run)
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
    const r = await provider.chat({ messages: history.messages });
    if (!r.ok) {
      console.error(`✗ ${r.error?.message || 'chat failed'}\n`);
      // pop the failed user message so history stays clean
      history.messages.pop();
      rl.prompt();
      return;
    }
    history.messages.push({ role: 'assistant', content: r.value.content });
    await memory.set(HISTORY_KEY, history);
    console.log(`\n${provider.name}> ${r.value.content}\n`);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 bye');
    process.exit(0);
  });
}
