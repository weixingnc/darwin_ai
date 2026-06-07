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

export async function chat(text) {
  if (!text || !text.trim()) {
    throw new Error('chat: missing message text. Usage: darwin chat "hello"');
  }

  const { registry } = await sharedBootstrap();

  if (registry.list().length === 0) {
    console.log('⚠ No provider configured. Run: darwin config add provider-anthropic');
    process.exit(EXIT_NO_PROVIDER);
  }

  const provider = registry.list()[0];
  console.log(`🤖 Using ${provider.name}\n`);

  const r = await provider.chat({
    messages: [{ role: 'user', content: text }],
  });

  if (!r.ok) {
    console.error(`✗ ${r.error?.message || 'chat failed'}`);
    process.exit(EXIT_CHAT_FAIL);
  }

  console.log(r.value.content);
  return EXIT_OK;
}
