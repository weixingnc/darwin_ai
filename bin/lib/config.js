/**
 * darwin config — interactive add + redacted show.
 *
 * Supported modules:
 *   - provider-anthropic:  base_url / api_key (→ .env) / default_model / version
 *   - provider-openai:     base_url / api_key (→ .env) / default_model
 *
 * Storage (3-layer):
 *   ~/.darwin/darwin.yaml   non-secret config (uses ${VAR} placeholders)
 *   ~/.darwin/.env          true secrets (NEVER committed)
 *
 * v2 hygiene (Darwin ANTI-PATTERNS A-4): NO hard-coded env reads, all access
 * goes through ConfigResolver.get() at runtime.
 */

import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigResolver } from '../../core/config-resolver.js';

const SECRET_FIELDS = [
  'api_key',
  'app_secret',
  'token',
  'password',
  'verification_token',
  'encrypt_key',
];
const REDACTED = '***REDACTED***';

function _ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveQ) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveQ(answer.trim());
    });
  });
}

function _userDir() {
  const dir = join(homedir(), '.darwin');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function _writeSecret(envPath, key, value) {
  let cur = '';
  if (existsSync(envPath)) {
    cur = readFileSync(envPath, 'utf8');
  }
  const line = `${key}=${value}\n`;
  if (cur.includes(`${key}=`)) {
    // replace existing
    cur = cur.replace(new RegExp(`^${key}=.*$`, 'm'), line.trimEnd());
    writeFileSync(envPath, cur);
  } else {
    writeFileSync(envPath, cur + line);
  }
}

export async function configAdd(moduleName) {
  if (!moduleName) {
    throw new Error('config add: missing module name. Usage: darwin config add provider-anthropic');
  }
  if (moduleName !== 'provider-anthropic' && moduleName !== 'provider-openai') {
    throw new Error(
      `config add: unknown module '${moduleName}'. Supported: provider-anthropic, provider-openai`,
    );
  }

  const dir = _userDir();
  // Per-module file (matches ConfigResolver._userFile() contract):
  //   ~/.darwin/<module>.yaml — not a single darwin.yaml, so chat/show agree
  const yamlPath = join(dir, `${moduleName}.yaml`);
  const envPath = join(dir, '.env');

  if (moduleName === 'provider-anthropic') {
    const baseUrl =
      (await _ask('base_url [https://api.anthropic.com]: ')) || 'https://api.anthropic.com';
    const apiKey = await _ask('api_key (required, will be saved to ~/.darwin/.env): ');
    if (!apiKey) {
      throw new Error('config add: api_key required for provider-anthropic');
    }
    const defaultModel = (await _ask('default_model [claude-sonnet-4-5]: ')) || 'claude-sonnet-4-5';
    const version = (await _ask('version [2023-06-01]: ')) || '2023-06-01';

    // Per-module file: top-level keys are the module's fields (no module-name prefix)
    const yaml = `base_url: ${baseUrl}\napi_key: \${ANTHROPIC_API_KEY}\ndefault_model: ${defaultModel}\nversion: ${version}\n`;
    writeFileSync(yamlPath, yaml);
    _writeSecret(envPath, 'ANTHROPIC_API_KEY', apiKey);
    console.log(`✓ Saved provider-anthropic:`);
    console.log(`  ${yamlPath}  (non-secret config)`);
    console.log(`  ${envPath}     (ANTHROPIC_API_KEY)`);
  } else {
    // provider-openai
    const baseUrl = (await _ask('base_url (required, e.g. https://api.openai.com/v1): ')).trim();
    if (!baseUrl) {
      throw new Error('config add: base_url required for provider-openai');
    }
    const apiKey = await _ask('api_key (required, will be saved to ~/.darwin/.env): ');
    if (!apiKey) {
      throw new Error('config add: api_key required for provider-openai');
    }
    const defaultModel = (await _ask('default_model [gpt-4o-mini]: ')) || 'gpt-4o-mini';

    const yaml = `base_url: ${baseUrl}\napi_key: \${OPENAI_API_KEY}\ndefault_model: ${defaultModel}\n`;
    writeFileSync(yamlPath, yaml);
    _writeSecret(envPath, 'OPENAI_API_KEY', apiKey);
    console.log(`✓ Saved provider-openai:`);
    console.log(`  ${yamlPath}  (non-secret config)`);
    console.log(`  ${envPath}     (OPENAI_API_KEY)`);
  }
}

export async function configShow() {
  const cfg = new ConfigResolver({
    codePath: resolve('./config'),
    userPath: join(homedir(), '.darwin'),
    credPath: join(homedir(), '.darwin', '.env'),
  });

  const modules = ['provider-anthropic', 'provider-openai', 'memory-default', 'darwin-runtime'];
  for (const m of modules) {
    let c;
    try {
      c = cfg.get(m);
    } catch {
      console.log(`\n[${m}] (not configured)`);
      continue;
    }
    console.log(`\n[${m}]`);
    for (const [k, v] of Object.entries(c)) {
      const isSecret = SECRET_FIELDS.some((s) => k.toLowerCase().includes(s));
      const display = isSecret ? REDACTED : JSON.stringify(v);
      console.log(`  ${k}: ${display}`);
    }
  }
}
