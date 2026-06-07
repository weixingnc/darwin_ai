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
const PERSONALITY_KEY = 'darwin-personality';
const EXIT_NO_PROVIDER = 2;

async function _getPersonality(memory) {
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
  const personality = await _getPersonality(memory);
  const identityLine = personality
    ? `   identity: ${personality.split('\n')[0].slice(0, 60)}${personality.length > 60 ? '…' : ''}`
    : '   identity: (unset — run: darwin memory set darwin-personality "你是 Darwin, ...")';
  console.log(`🤖 Darwin REPL — using ${provider.name}`);
  console.log(identityLine);
  console.log('   (Ctrl+D or "exit" to quit, "clear" to wipe history)\n');

  // Load persisted history (default empty if first run).
  // history only contains user/assistant turns; system prompt is injected
  // per-call from memory (so live `darwin memory set darwin-personality`
  // changes take effect on the next turn without restart).
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
    // Re-read personality each turn so live changes take effect immediately
    const livePersonality = await _getPersonality(memory);
    const fullMessages = [
      ...(livePersonality ? [{ role: 'system', content: livePersonality }] : []),
      ...history.messages,
    ];
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
    console.log(`\n${provider.name}> ${r.value.content}\n`);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 bye');
    process.exit(0);
  });
}
