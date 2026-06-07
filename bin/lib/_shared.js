/**
 * Shared bootstrap helper — used by chat (PR 19a) and repl/plugin/memory (PR 19b).
 *
 * Returns { bus, registry, memory }:
 *   - bus: EventBus
 *   - registry: ProviderRegistry with Anthropic + OpenAI-compatible auto-registered
 *   - memory: FilesystemBackend (default, from config/memory-default)
 *
 * Extracted to a shared file so 4 sub-commands (chat/repl/plugin/memory) all
 * wire the same way — one source of truth for "what does a Darwin CLI command
 * have access to at startup".
 */

import { bootstrap } from '../../lifecycle/bootstrap.js';
import { Container } from '../../core/container.js';
import { EventBus } from '../../core/event-bus.js';
import { ConfigResolver } from '../../core/config-resolver.js';
import { AnthropicProvider } from '../../provider/anthropic.js';
import { OpenAICompatibleProvider } from '../../provider/openai-compatible.js';
import { ProviderRegistry } from '../../provider/registry.js';
import { FilesystemBackend } from '../../memory/filesystem-backend.js';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export async function sharedBootstrap() {
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

  // Memory backend: filesystem default (Darwin v2 launch — sqlite available via direct import)
  const memory = FilesystemBackend();
  let memCfg;
  try {
    memCfg = cfg.get('memory-default');
  } catch {
    memCfg = null;
  }
  // Fallback: if memory-default not configured, default to ~/.darwin/memory.
  // FilesystemBackend requires non-empty `path`, so always provide one.
  if (!memCfg?.path) {
    memCfg = { backend: 'filesystem', path: join(homedir(), '.darwin', 'memory'), ...memCfg };
  }
  await memory.init({
    eventBus: bus,
    config: { get: (k) => (k === 'memory-default' ? memCfg : {}) },
    container: null,
  });

  return { bus, registry, memory };
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
