#!/usr/bin/env node
/**
 * basic-chat.mjs -- Example 1: end-to-end Darwin chat from a Node script.
 *
 * What it shows:
 *   1. How to load a provider (deepseek) from Darwin's plugin loader
 *   2. How to wire the EventBus so you can subscribe to events
 *   3. How to send a single chat prompt and read the reply
 *   4. How to do this WITHOUT the full self-evolution loop
 *      (i.e. as a library, not as the CLI orchestrator)
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-...
 *   node examples/basic-chat/basic-chat.mjs
 *
 * No Darwin daemon, no config files -- just a 60-line script.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// 1. Boot a minimal Darwin runtime (event bus + provider registry)
import { EventBus } from '../../core/event-bus.js';
import { createProviderLoader } from '../../provider/loader.js';

const bus = new EventBus();

// Optional: log every evolution:audit event so you SEE what the
// provider emits. (Mechanically useful for debugging.)
bus.on('evolution:audit', (entry) => {
  console.log(`[event] ${entry.topic} proposal=${entry.payload?.proposal_id || '-'}`);
});

// 2. Load the deepseek provider (uses ConfigResolver under the hood)
const loader = createProviderLoader({ eventBus: bus });
const provider = await loader.load('deepseek');
await loader.init('deepseek');
await loader.enable('deepseek');

const ds = provider.providers?.get?.('deepseek') || provider.get?.('deepseek');
if (!ds || typeof ds.chat !== 'function') {
  console.error('Provider loaded but chat() not available. Check provider/registry.js.');
  process.exit(1);
}

// 3. Send a prompt
const prompt = process.argv.slice(2).join(' ') || 'What is Darwin in one sentence?';
console.log(`\n> ${prompt}\n`);

try {
  const reply = await ds.chat({ prompt });
  console.log(reply.text || JSON.stringify(reply));
} catch (err) {
  console.error('chat() failed:', err.message);
  process.exit(1);
}

// 4. Clean shutdown (disable + unload)
await loader.disable('deepseek');
await loader.unload('deepseek');