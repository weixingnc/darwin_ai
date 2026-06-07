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

import { bootstrap } from '../../lifecycle/bootstrap.js';
import { Container } from '../../core/container.js';
import { EventBus } from '../../core/event-bus.js';
import { ConfigResolver } from '../../core/config-resolver.js';
import { AnthropicProvider } from '../../provider/anthropic.js';
import { OpenAICompatibleProvider } from '../../provider/openai-compatible.js';
import { ProviderRegistry } from '../../provider/registry.js';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const EXIT_OK = 0;
const EXIT_NO_PROVIDER = 2;
const EXIT_CHAT_FAIL = 3;

export async function chat(text) {
  if (!text || !text.trim()) {
    throw new Error('chat: missing message text. Usage: darwin chat "hello"');
  }

  const { registry } = await _bootstrap();

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

async function _bootstrap() {
  const bus = new EventBus();
  const container = new Container();
  container.register('eventBus', () => bus);

  const cfg = new ConfigResolver({
    codePath: resolve('./config'),
    userPath: join(homedir(), '.darwin'),
    credPath: join(homedir(), '.darwin', '.env'),
  });
  container.register('configResolver', () => cfg);
  bootstrap({ container });

  const registry = new ProviderRegistry({ eventBus: bus });
  _tryRegisterAnthropic(cfg, registry, bus);
  _tryRegisterOpenAI(cfg, registry, bus);

  return { bus, registry };
}

function _tryRegisterAnthropic(cfg, registry, bus) {
  let a;
  try {
    a = cfg.get('provider-anthropic');
  } catch {
    return;
  }
  if (!a?.api_key) {
    return;
  }
  registry.register(
    new AnthropicProvider({
      baseUrl: a.base_url || 'https://api.anthropic.com',
      apiKey: a.api_key,
      defaultModel: a.default_model || 'claude-sonnet-4-5',
      version: a.version || '2023-06-01',
      eventBus: bus,
    }),
  );
}

function _tryRegisterOpenAI(cfg, registry, bus) {
  let o;
  try {
    o = cfg.get('provider-openai');
  } catch {
    return;
  }
  if (!o?.api_key) {
    return;
  }
  registry.register(
    new OpenAICompatibleProvider({
      name: 'openai-compatible',
      baseUrl: o.base_url,
      apiKey: o.api_key,
      defaultModel: o.default_model || 'gpt-4o-mini',
      eventBus: bus,
    }),
  );
}
