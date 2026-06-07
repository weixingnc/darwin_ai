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

  // Build a "prior conversation" system-context block from the last N turns.
  // Without this, the LLM treats history.messages as continuation and doesn't
  // anchor on prior facts. With this, the model sees an explicit "you already
  // talked to this user about X" — recall works.
  const HISTORY_CONTEXT_LIMIT = 10;
  const HISTORY_TURN_CHAR_CAP = 180;
  function historyToContext(messages) {
    const recent = messages.slice(-HISTORY_CONTEXT_LIMIT);
    if (recent.length === 0) {
      return null;
    }
    const lines = recent.map((m) => {
      const label = m.role === 'user' ? '用户' : '你';
      const trimmed = String(m.content || '')
        .replace(/\s+/g, ' ')
        .slice(0, HISTORY_TURN_CHAR_CAP);
      return `${label}: ${trimmed}`;
    });
    return `以下是你与该用户最近的对话历史（请记住关键信息，回复时自然引用即可）:\n${lines.join('\n')}`;
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
    // Re-read personality each turn so live changes take effect immediately.
    // Inject historyToContext as an explicit system block so the LLM treats
    // prior turns as "things you already know about this user" instead of
    // just chat continuation. Critical for cross-session recall.
    const livePersonality = await _getPersonality(memory);
    const historyContext = historyToContext(history.messages);
    const systemMessages = [];
    if (livePersonality) {
      systemMessages.push({ role: 'system', content: livePersonality });
    }
    if (historyContext) {
      systemMessages.push({ role: 'system', content: historyContext });
    }
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
    console.log(`\n${provider.name}> ${r.value.content}\n`);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 bye');
    process.exit(0);
  });
}
