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
import { loadContext } from '../../core/context-loader.js';

const EXIT_OK = 0;
const EXIT_NO_PROVIDER = 2;
const EXIT_CHAT_FAIL = 3;

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

  // 5-layer context: identity + personality + learnings + history + this turn.
  // Chat is one-shot so history is always empty; layers 1-3 do the work.
  const { systemMessages } = await loadContext({ memory, historyMessages: [] });
  const fullMessages = [...systemMessages, { role: 'user', content: text }];

  const r = await provider.chat(fullMessages);

  if (!r.ok) {
    console.error(`✗ ${r.error?.message || 'chat failed'}`);
    process.exit(EXIT_CHAT_FAIL);
  }

  console.log(r.value.content);
  return EXIT_OK;
}
