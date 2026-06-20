/**
 * ConfigResolver: 3-layer config with ${VAR} expansion.
 *
 * v1 lesson (ANTI-PATTERNS A-4): adapter-feishu L86-90 had hard-coded env read
 * with no fallback. v2 rule: ALL config access goes through ConfigResolver.get().
 *
 * Layers (highest priority first):
 * 1. credential layer: ~/.darwin/.env (true values, never commit)
 * 2. user layer:      ~/.darwin/<module>.yaml (user overrides)
 * 3. code layer:      ./config/<module>.yaml (defaults, committed)
 *
 * ${VAR} expansion: reads process.env + credential env at resolve time.
 * Missing var: returns '' (empty string), warns to console, NEVER throws.
 *   (v1 threw on missing env, breaking the whole adapter — anti-pattern.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export class ConfigResolver {
  constructor(options = {}) {
    this.codePath = options.codePath || resolve('./config');
    this.userPath = options.userPath || join(homedir(), '.darwin');
    this.credPath = options.credPath || join(homedir(), '.darwin', '.env');
    // V10.7: single-file config option. Useful for tests + tiny deployments.
    this.configPath = options.configPath || null;
    this._cache = new Map();
  }

  /**
   * Get merged config for a module. Deep-merges all 3 layers.
   * @param {string} moduleName - e.g. 'adapter-feishu', 'provider-openai'
   * @returns {object} merged + expanded config (always a fresh object on miss)
   */
  get(moduleName) {
    if (typeof moduleName !== 'string' || moduleName.length === 0) {
      throw new TypeError('[ConfigResolver] get: moduleName must be non-empty string');
    }
    if (this._cache.has(moduleName)) {
      return this._cache.get(moduleName);
    }

    // V10.7: configPath is highest-priority data layer (last in merge wins).
    // data layers: code (lowest) -> user -> configPath (highest). env is special
    // (only feeds into dollar-VAR expansion; deep merge skips _env key).
    const layers = [
      this._readFile(this._codeFile(moduleName)),
      this._readFile(this._userFile(moduleName)),
      this._readConfigPath(moduleName),
      { _env: this._readEnv() },
    ];
    const merged = this._deepMerge(...layers);
    const expanded = this._expand(merged);
    delete expanded._env;
    this._cache.set(moduleName, expanded);
    return expanded;
  }

  /**
   * Invalidate cache. Pass moduleName to clear one, omit to clear all.
   * @param {string} [moduleName]
   */
  invalidate(moduleName) {
    if (moduleName) {
      this._cache.delete(moduleName);
    } else {
      this._cache.clear();
    }
  }

  // ─── private ──────────────────────────────────────
  /**
   * V10.7: read a single-file config keyed by moduleName. Returns
   * the module subtree (or {} on miss / missing file / parse fail).
   * Highest priority layer -- overrides both codePath and userPath
   * for the modules present in the file. Modules absent from the
   * file transparently fall through to lower layers.
   */
  _readConfigPath(moduleName) {
    if (!this.configPath) {
      return {};
    }
    if (!existsSync(this.configPath)) {
      return {};
    }
    let all;
    try {
      all = this._parseSimpleYaml(readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      console.warn('[ConfigResolver] failed to load ' + this.configPath + ': ' + err.message);
      return {};
    }
    return all[moduleName] || {};
  }

  _codeFile(m) {
    return join(this.codePath, `${m}.yaml`);
  }

  _userFile(m) {
    return join(this.userPath, `${m}.yaml`);
  }

  _readFile(path) {
    if (!existsSync(path)) {
      return {};
    }
    try {
      return this._parseSimpleYaml(readFileSync(path, 'utf8'));
    } catch (err) {
      console.warn(`[ConfigResolver] failed to load ${path}: ${err.message}`);
      return {};
    }
  }

  _readEnv() {
    if (!existsSync(this.credPath)) {
      return {};
    }
    const env = {};
    const content = readFileSync(this.credPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    return env;
  }

  _parseSimpleYaml(content) {
    // v2 启动期 mini YAML parser: supports 1-level nesting via 2-space indent.
    // Deeper nesting is intentionally NOT supported — use a yaml package later.
    const result = {};
    let parentKey = null;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trimEnd();
      if (line.trim() === '') {
        continue;
      }
      const m = line.match(/^(\s*)([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
      if (!m) {
        continue;
      }
      const indent = m[1].length;
      const key = m[2];
      let value = m[3];
      try {
        value = JSON.parse(value);
      } catch {
        /* keep as string */
      }
      if (indent === 0) {
        result[key] = value;
        parentKey = value === '' ? key : null;
      } else if (indent === 2 && parentKey) {
        if (
          !result[parentKey] ||
          typeof result[parentKey] !== 'object' ||
          Array.isArray(result[parentKey])
        ) {
          result[parentKey] = {};
        }
        result[parentKey][key] = value;
      }
    }
    return result;
  }

  _deepMerge(...sources) {
    const result = {};
    for (const src of sources) {
      if (!src) {
        continue;
      }
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && k !== '_env') {
          result[k] = this._deepMerge(result[k] || {}, v);
        } else {
          result[k] = v;
        }
      }
    }
    return result;
  }

  _expand(obj) {
    const credEnv = obj._env || {};
    const walk = (v) => {
      if (typeof v === 'string') {
        return v.replace(/\$\{([^}]+)\}/g, (_, name) => {
          if (credEnv[name] !== undefined) {
            return credEnv[name];
          }
          if (process.env[name] !== undefined) {
            return process.env[name];
          }
          console.warn(`[ConfigResolver] unresolved placeholder: \${${name}}`);
          return '';
        });
      }
      if (Array.isArray(v)) {
        return v.map(walk);
      }
      if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          if (k === '_env') {
            continue;
          }
          out[k] = walk(val);
        }
        return out;
      }
      return v;
    };
    return walk(obj);
  }
}
