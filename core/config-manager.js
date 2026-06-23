/**
 * core/config-manager.js -- V43: CRUD for provider configs at the
 * user layer (~/.darwin/<id>.yaml), plus an "active provider"
 * pointer and a small vendor schema catalog used by the web UI
 * to build a dynamic form.
 *
 * Storage (matches existing `darwin config add` convention):
 *   ~/.darwin/<id>.yaml         non-secret config (api_key is "${ENV_VAR}")
 *   ~/.darwin/.env              true secrets (KEY=value per line)
 *   ~/.darwin/darwin-runtime.yaml  active provider/model pointer
 *
 * Why a separate file per provider:
 *   - matches the existing ConfigResolver layer model
 *   - makes atomic writes easy (one provider = one file)
 *   - lets a human edit one provider without touching others
 *
 * Redaction:
 *   listProviders() returns { id, ...config, api_key: "abcd****" }.
 *   The real value is only on disk and is returned in full by
 *   getProvider(id, { reveal: true }), used by the "test connection"
 *   handler and by the "edit" handler that wants to confirm before
 *   saving.
 *
 * Vendor schema:
 *   Hard-coded list of supported providers. Each entry has:
 *     id, label, kind ("openai" | "anthropic"), defaultModel,
 *     defaultBaseUrl, fields[ { name, label, type, secret, required,
 *     placeholder, default } ]
 *   The web UI GETs /api/config/schema and uses this to render the
 *   "add provider" form dynamically. Adding a new vendor is a one-line
 *   change here -- no UI code change needed.
 *
 * Active provider:
 *   Stored in ~/.darwin/darwin-runtime.yaml under `active_provider`
 *   and `active_model`. The web UI shows a global switcher; chat
 *   requests read this to decide which provider+model to use.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigResolver } from './config-resolver.js';

const SECRET_FIELDS = [
  'api_key',
  'app_secret',
  'token',
  'password',
  'verification_token',
  'encrypt_key',
];

// V43: vendor catalog. The web UI uses this to build a dynamic
// form. Each entry has the schema the form expects.
//
// To add a new vendor: append a new entry below. The UI will
// automatically pick it up. No web UI code change needed.
export const VENDOR_SCHEMA = [
  {
    id: 'openai',
    label: 'OpenAI (official)',
    kind: 'openai',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.openai.com/v1',
        default: 'https://api.openai.com/v1',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk-...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'gpt-4o-mini',
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://api.anthropic.com',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk-ant-...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'claude-sonnet-4-5',
      },
      {
        name: 'version',
        label: 'API Version',
        type: 'text',
        required: false,
        default: '2023-06-01',
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (OpenAI compatible)',
    kind: 'openai',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://api.deepseek.com/v1',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk-...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'deepseek-chat',
      },
    ],
  },
  {
    id: 'qwen',
    label: 'Tongyi Qwen (DashScope, OpenAI compatible)',
    kind: 'openai',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      {
        name: 'api_key',
        label: 'API Key (sk-...)',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk-...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'qwen-plus',
      },
    ],
  },
  {
    id: 'glm',
    label: 'Zhipu GLM (OpenAI compatible)',
    kind: 'openai',
    defaultModel: 'glm-4-plus',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://open.bigmodel.cn/api/paas/v4',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'glm-4-plus',
      },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi (OpenAI compatible)',
    kind: 'openai',
    defaultModel: 'moonshot-v1-8k',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://api.moonshot.cn/v1',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk-...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'moonshot-v1-8k',
      },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax (OpenAI compatible)',
    kind: 'openai',
    defaultModel: 'MiniMax-Text-01',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'https://api.minimaxi.com/v1',
      },
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '...',
      },
      {
        name: 'default_model',
        label: 'Default Model',
        type: 'text',
        required: true,
        default: 'MiniMax-Text-01',
      },
    ],
  },
];

// V43: redact a single value. Returns the first 4 chars + "****" or
// REDACTED for empty/short values.
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  if (value.length <= 4) {
    return '****';
  }
  return value.slice(0, 4) + '****';
}

// V43: deep-redact an object. Returns a fresh object so the caller
// cannot accidentally mutate the underlying data.
export function redactObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && SECRET_FIELDS.some((s) => k.toLowerCase() === s)) {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class ConfigManager {
  constructor(options = {}) {
    this.userDir = options.userDir || join(homedir(), '.darwin');
    this.envPath = options.envPath || join(this.userDir, '.env');
    this.runtimePath = options.runtimePath || join(this.userDir, 'darwin-runtime.yaml');
    // Allow tests to override where the ConfigResolver reads from.
    this.codePath = options.codePath || resolve('./config');
    this.credPath = this.envPath;
  }

  _ensureDir() {
    if (!existsSync(this.userDir)) {
      mkdirSync(this.userDir, { recursive: true });
    }
  }

  // V43: list all provider ids by scanning the user dir for files
  // matching `provider-*.yaml`. Returns ids without the prefix.
  listProviderIds() {
    if (!existsSync(this.userDir)) {
      return [];
    }
    return readdirSync(this.userDir)
      .filter((f) => f.startsWith('provider-') && f.endsWith('.yaml'))
      .map((f) => f.slice('provider-'.length, -'.yaml'.length));
  }

  // V43: get a single provider's config. When reveal=true, returns
  // the real api_key. When false (default), redacts secrets.
  getProvider(id, { reveal = false } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('invalid provider id');
    }
    const path = join(this.userDir, `provider-${id}.yaml`);
    if (!existsSync(path)) {
      return null;
    }
    // Use ConfigResolver to get a merged view, so the user can
    // also see code-layer defaults alongside their overrides.
    const resolver = new ConfigResolver({
      codePath: this.codePath,
      userPath: this.userDir,
      credPath: this.credPath,
    });
    const merged = resolver.get(`provider-${id}`);
    if (reveal) {
      return merged;
    }
    return redactObject(merged);
  }

  // V43: list all providers (id + redacted config). Includes a
  // `kind` field derived from the VENDOR_SCHEMA so the UI knows
  // whether the entry is openai-compatible or anthropic.
  listProviders() {
    const ids = this.listProviderIds();
    const out = [];
    for (const id of ids) {
      const cfg = this.getProvider(id, { reveal: false });
      if (!cfg) {
        continue;
      }
      const schema = VENDOR_SCHEMA.find((v) => v.id === id);
      out.push({
        id,
        kind: schema ? schema.kind : 'openai',
        label: schema ? schema.label : id,
        ...cfg,
      });
    }
    return out;
  }

  // V43: add or overwrite a provider. The `data` object contains
  // the fields to write. If a secret field is present and reveal=true,
  // it is written to .env and a ${VAR} placeholder is written to yaml.
  upsertProvider(id, data, { reveal = false } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('invalid provider id');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('upsertProvider: data must be an object');
    }
    this._ensureDir();

    // Separate secrets from non-secrets. Secrets go to .env with
    // a stable, prefixed env var name.
    const yamlLines = [];
    const envWrites = [];
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string') {
        yamlLines.push(`${k}: ${JSON.stringify(v)}`);
        continue;
      }
      const isSecret = SECRET_FIELDS.some((s) => k.toLowerCase() === s);
      if (isSecret && reveal) {
        const envKey = `DARWIN_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${k.toUpperCase()}`;
        envWrites.push([envKey, v]);
        yamlLines.push(`${k}: ${'${'}${envKey}${'}'}`);
      } else {
        yamlLines.push(`${k}: ${v}`);
      }
    }
    writeFileSync(join(this.userDir, `provider-${id}.yaml`), yamlLines.join('\n') + '\n');
    if (envWrites.length > 0) {
      this._writeSecrets(envWrites);
    }
    return { id, written: yamlLines.length, envVars: envWrites.map(([k]) => k) };
  }

  // V43: delete a provider and its secrets.
  deleteProvider(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('invalid provider id');
    }
    const path = join(this.userDir, `provider-${id}.yaml`);
    if (!existsSync(path)) {
      return { deleted: false, reason: 'not found' };
    }
    unlinkSync(path);
    return { deleted: true };
  }

  // V43: tiny 1-level / 2-space-indent YAML parser for the
  // runtime-active file. Extracted from getActive() so the latter
  // stays under the complexity limit.
  _parseRuntimeYaml(text) {
    const out = {};
    let parent = null;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trimEnd();
      if (!line.trim()) {
        continue;
      }
      const m = line.match(/^(\s*)([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
      if (!m) {
        continue;
      }
      const indent = m[1].length;
      const key = m[2];
      const rawVal = m[3];
      let value;
      try {
        value = JSON.parse(rawVal);
      } catch {
        value = rawVal;
      }
      if (indent === 0) {
        out[key] = value;
        parent = value === '' ? key : null;
      } else if (indent === 2 && parent) {
        if (!out[parent] || typeof out[parent] !== 'object' || Array.isArray(out[parent])) {
          out[parent] = {};
        }
        out[parent][key] = value;
      }
    }
    return out;
  }

  // V43: read the active provider pointer. Returns
  // { provider: "openai", model: "gpt-4o-mini" } or null.
  getActive() {
    if (!existsSync(this.runtimePath)) {
      return null;
    }
    const out = this._parseRuntimeYaml(readFileSync(this.runtimePath, 'utf8'));
    const block = out['darwin-runtime'];
    if (!block || typeof block !== 'object') {
      return null;
    }
    if (!block.active_provider) {
      return null;
    }
    return { provider: block.active_provider, model: block.active_model || null };
  }

  // V43: set the active provider. Validates that the provider exists
  // and (if model is omitted) falls back to the provider's default_model.
  setActive(providerId, model) {
    if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
      throw new Error('invalid provider id');
    }
    const cfg = this.getProvider(providerId, { reveal: true });
    if (!cfg) {
      throw new Error(`provider not configured: ${providerId}`);
    }
    const useModel = model || cfg.default_model || null;
    this._ensureDir();
    const yaml = [
      'darwin-runtime:',
      `  active_provider: ${providerId}`,
      `  active_model: ${useModel || ''}`,
      '',
    ].join('\n');
    writeFileSync(this.runtimePath, yaml);
    return { provider: providerId, model: useModel };
  }

  // V43: append/replace a list of [key, value] pairs in .env.
  _writeSecrets(entries) {
    this._ensureDir();
    let cur = '';
    if (existsSync(this.envPath)) {
      cur = readFileSync(this.envPath, 'utf8');
    }
    for (const [k, v] of entries) {
      const line = `${k}=${v}\n`;
      if (cur.match(new RegExp(`^${k}=`, 'm'))) {
        cur = cur.replace(new RegExp(`^${k}=.*$`, 'm'), line.trimEnd());
        cur += '\n';
      } else {
        cur += line;
      }
    }
    writeFileSync(this.envPath, cur);
  }
}
