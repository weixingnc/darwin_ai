/**
 * darwin chat — single-shot chat via first configured provider.
 *
 * Wires: ConfigResolver → Container → bootstrap → ProviderRegistry → Anthropic | OpenAI-compatible.
 * Picks the first registered provider; prints reply; exits 0.
 *
 * Exits:
 *   0  success
 *   1  generic error
 *   2  no provider configured
 *   3  chat failed (r.ok === false)
 */

import { sharedBootstrap } from './_shared.js';

const EXIT_OK = 0;
const EXIT_NO_PROVIDER = 2;
const EXIT_CHAT_FAIL = 3;

const PERSONALITY_KEY = 'darwin-personality';

export async function chat(text) {
  if (!text || !text.trim()) {
    throw new Error('chat: missing message text. Usage: darwin chat "hello"');
  }

  const { registry, memory } = await sharedBootstrap();

  if (registry.list().length === 0) {
    console.log('⚠ No provider configured. Run: darwin config add provider-anthropic');
    process.exit(EXIT_NO_PROVIDER);
  }

  const provider = registry.list()[0];
  console.log(`🤖 Using ${provider.name}\n`);

  // Darwin identity: read system prompt from memory. If set, prepend to messages.
  // Lets user give Darwin a persistent, mutable identity without code changes.
  const messages = [];
  const personality = await _getPersonality(memory);
  if (personality) {
    messages.push({ role: 'system', content: personality });
  }
  messages.push({ role: 'user', content: text });

  const r = await provider.chat(messages);

  if (!r.ok) {
    console.error(`✗ ${r.error?.message || 'chat failed'}`);
    process.exit(EXIT_CHAT_FAIL);
  }

  console.log(r.value.content);
  return EXIT_OK;
}

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
