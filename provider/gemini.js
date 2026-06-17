/**
 * Gemini provider — Gemini-specific wire format (V3+ P1, cycle 9, 5/6).
 * NOT OpenAI-compatible: URL `/v1beta/models/{m}:generateContent`, auth
 * `?key=` query, bodies use `contents[]`+`systemInstruction`+`functionCall`.
 * A-3 严守: cannot reuse `createOpenAICompatibleProtocol` (no double-impl),
 * so this provider inlines `_geminiProtocol`. TODO(p2): extract to
 * `provider/protocol/gemini-protocol.js` when 2nd Gemini user arrives.
 * A-4: ConfigResolver only, no process.env. LLM gate: chat() only.
 */

import { ProviderBase } from './base.js';
import { ConfigResolver } from '../core/config-resolver.js';

const NOT_IMPLEMENTED_MSG = '[gemini] NOT_IMPLEMENTED';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const STATIC_MODELS = Object.freeze(['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']);

/** Role dispatchers — keep _geminiProtocol.{buildRequest,parseResponse}
 * complexity under ESLint's max-15. Mapping: system → top-level
 * systemInstruction; user→role='user'; asst→role='model'; tool→role='function'.
 * Response: parts[].text → content, .functionCall → toolCalls[],
 * usageMetadata → usage. */
function _roleSystem(m, sysText) {
  return { sysText: sysText + (sysText ? '\n' : '') + (m.content || ''), content: null };
}
function _roleUser(m) {
  return { sysText: null, content: { role: 'user', parts: [{ text: m.content || '' }] } };
}
function _roleAssistant(m) {
  const parts = [];
  if (m.content) {
    parts.push({ text: m.content });
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
    }
  }
  return { sysText: null, content: { role: 'model', parts } };
}
function _roleTool(m) {
  return {
    sysText: null,
    content: {
      role: 'function',
      parts: [{ functionResponse: { name: m.name || '', response: m.content || '' } }],
    },
  };
}
const _ROLE_DISPATCH = {
  system: _roleSystem,
  user: _roleUser,
  assistant: _roleAssistant,
  tool: _roleTool,
};

function _firstCandidateParts(raw) {
  if (!raw || !Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    return null;
  }
  const cand = raw.candidates[0];
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
    return [];
  }
  return cand.content.parts;
}

function _collectContentAndToolCalls(parts) {
  let content = '';
  const toolCalls = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') {
      continue;
    }
    if (typeof p.text === 'string' && !p.functionCall) {
      content += p.text;
    }
    if (p.functionCall) {
      toolCalls.push({ name: p.functionCall.name || '', args: p.functionCall.args || {} });
    }
  }
  return { content, toolCalls };
}

function _extractUsage(u) {
  const m = u || {};
  return {
    prompt_tokens: m.promptTokenCount || 0,
    completion_tokens: m.candidatesTokenCount || 0,
    total_tokens: m.totalTokenCount || 0,
  };
}

const _geminiProtocol = {
  buildRequest(messages, _options, _model) {
    if (!Array.isArray(messages)) {
      return { ok: false, error: new TypeError('messages must be an array') };
    }
    const contents = [];
    let sysText = '';
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        return { ok: false, error: new TypeError('each message must be an object') };
      }
      const fn = _ROLE_DISPATCH[m.role];
      if (!fn) {
        return { ok: false, error: new Error(`unsupported role: ${m.role}`) };
      }
      const out = fn(m, sysText);
      if (out.sysText !== null) {
        sysText = out.sysText;
      }
      if (out.content) {
        contents.push(out.content);
      }
    }
    const body = { contents };
    if (sysText) {
      body.systemInstruction = { parts: [{ text: sysText }] };
    }
    return { ok: true, value: body };
  },

  parseResponse(raw) {
    try {
      const first = _firstCandidateParts(raw);
      if (!first) {
        return { ok: false, error: new Error('no candidates in response') };
      }
      const { content, toolCalls } = _collectContentAndToolCalls(first);
      return {
        ok: true,
        value: { content, tool_calls: toolCalls, usage: _extractUsage(raw.usageMetadata) },
      };
    } catch (e) {
      return { ok: false, error: e };
    }
  },
};

function normalizeBaseUrl(u) {
  if (typeof u !== 'string' || u.length === 0) {
    return '';
  }
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function extractErrorMessage(rawBody, status) {
  try {
    if (rawBody && typeof rawBody === 'object') {
      if (rawBody.error && typeof rawBody.error === 'object' && rawBody.error.message) {
        return String(rawBody.error.message);
      }
      if (rawBody.error && typeof rawBody.error === 'string') {
        return rawBody.error;
      }
      if (rawBody.message) {
        return String(rawBody.message);
      }
    }
  } catch {
    /* fall through */
  }
  return `HTTP ${status}`;
}

function wrapHttpError(raw, status) {
  const err = new Error(`[gemini] HTTP ${status}: ${extractErrorMessage(raw, status)}`);
  err.status = status;
  err.raw = raw;
  return err;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GeminiProvider: Google AI for Developers (Gemini LLM). */
export class GeminiProvider extends ProviderBase {
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[gemini] constructor: opts.eventBus is required');
    }
    super({
      name: 'gemini',
      capabilities: ['chat', 'tool-call', 'list-models'],
      eventBus: opts.eventBus,
    });
    this._baseUrl = normalizeBaseUrl(opts.baseUrl);
    this._apiKey = opts.apiKey || '';
    this._defaultModel = opts.defaultModel || 'gemini-2.0-flash';
    this._timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    // A-3: inline Gemini protocol seam (TODO(p2) extract when 2nd user arrives).
    this._geminiProtocol = _geminiProtocol;
  }

  async _doChat(messages, options = {}) {
    const opts = options || {};
    const model = (typeof opts.model === 'string' && opts.model) || this._defaultModel;
    const built = this._geminiProtocol.buildRequest(messages, opts, model);
    if (!built.ok) {
      throw built.error;
    }
    const url = `${this._baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this._apiKey)}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.value),
      },
      this._timeoutMs,
    );
    const raw = await res.json();
    if (!res.ok) {
      throw wrapHttpError(raw, res.status);
    }
    const parsed = this._geminiProtocol.parseResponse(raw);
    if (!parsed.ok) {
      throw parsed.error;
    }
    return {
      content: parsed.value.content,
      toolCalls: parsed.value.tool_calls,
      usage: parsed.value.usage,
      raw,
    };
  }

  async _doListModels() {
    return [...STATIC_MODELS];
  }

  async _doEmbed(_t) {
    throw new Error(NOT_IMPLEMENTED_MSG);
  }

  /** Build a provider from ConfigResolver config (A-4: never process.env). */
  static fromConfig(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[gemini] fromConfig: opts.eventBus is required');
    }
    const resolver = opts.resolver || new ConfigResolver();
    const key = typeof opts.configKey === 'string' ? opts.configKey : 'provider-gemini';
    const cfg = resolver.get(key) || {};
    return new GeminiProvider({
      eventBus: opts.eventBus,
      baseUrl: cfg.base_url || cfg.baseUrl || DEFAULT_BASE,
      apiKey: cfg.api_key || cfg.apiKey || '',
      defaultModel: cfg.default_model || cfg.defaultModel || 'gemini-2.0-flash',
      timeoutMs: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
    });
  }
}
