/**
 * Provider protocol shared helpers — V10.2 (2026-06-20).
 *
 * Before V10.2, every OpenAI-compatible provider (qwen, deepseek, openai,
 * gemini-ish) carried its own near-identical copies of these helpers:
 *
 *   normalizeBaseUrl    (URL tail-stripping; per-vendor variants)
 *   bearerAuthHeader    (Authorization: Bearer <apiKey>)
 *   fetchWithTimeout    (AbortController + setTimeout)
 *   extractErrorMessage (parse { error: {message} } | { message } | { error: 'str' })
 *   wrapHttpError       (Error with .status + .raw attached)
 *   extractReasoning*   (parse choices[0].message.reasoning_content,
 *                        return '' or null when absent per vendor)
 *
 * The duplication was called out in V8.1 reviewer S2 (2026-06-19) and
 * again in V9.1 / V9.2 reviewer backlogs. V10.2 makes _shared.js the
 * single source of truth and migrates the 3 worst offenders (qwen,
 * deepseek, gemini). claude-3.5 uses anthropic-protocol (different
 * shape) and is left for V10.2.5+. openai.js is 54 lines and inline-
 * uses the same patterns; migration is a stylistic-only win, deferred.
 *
 * LLM gate (ADR-009): pure data-shaping + HTTP helpers, no LLM.
 */
import path from 'node:path';

/**
 * Normalize a provider base URL by stripping trailing slashes and
 * optional common prefixes (e.g. /v1, /compatible-mode/v1) that callers
 * sometimes include. Per-vendor variants go through `opts`:
 *
 *   normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1',
 *                    { stripCompatibleMode: true })
 *     -> 'https://dashscope.aliyuncs.com'
 *
 *   normalizeBaseUrl('https://api.openai.com/v1/')
 *     -> 'https://api.openai.com'
 *
 * Returns '' if input is not a non-empty string (callers compare with
 * `''` to detect missing config).
 *
 * @param {unknown} url
 * @param {{stripCompatibleMode?: boolean}} [opts]
 * @returns {string}
 */
export function normalizeBaseUrl(url, opts = {}) {
  if (typeof url !== 'string' || url.length === 0) {
    return '';
  }
  let u = url.endsWith('/') ? url.slice(0, -1) : url;
  if (opts.stripCompatibleMode) {
    u = u.replace(/\/compatible-mode\/v1$/, '');
  }
  u = u.replace(/\/v1$/, '');
  return u;
}

/**
 * Standard Authorization: Bearer <apiKey> header for OpenAI-compatible
 * and most LLM providers. Content-Type is application/json.
 *
 * @param {string} apiKey
 * @returns {{'Content-Type': string, Authorization: string}}
 */
export function bearerAuthHeader(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  };
}

/**
 * fetch() with a hard timeout via AbortController. Cleans up the timer
 * in finally so the process never leaks. Aborts the fetch on timeout
 * (status 408 in the network sense, but the caller should treat
 * any AbortError as a timeout).
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a human-readable error message from a parsed HTTP response
 * body. Vendor variations handled:
 *   { error: { message: '...' } }     -> '...'
 *   { error: { message: '...', type: '...' } }  -> '...'
 *   { error: 'rate_limit_exceeded' }  -> 'rate_limit_exceeded'
 *   { message: 'something failed' }   -> 'something failed'
 *   anything else                    -> `HTTP <status>`
 *
 * Never throws (the try/catch around the body parse covers malformed
 * payloads). On parse failure, falls back to a generic message.
 *
 * @param {unknown} rawBody
 * @param {number} status
 * @returns {string}
 */
export function extractErrorMessage(rawBody, status) {
  try {
    if (rawBody && typeof rawBody === 'object') {
      if (rawBody.error) {
        if (typeof rawBody.error === 'object' && rawBody.error.message) {
          return String(rawBody.error.message);
        }
        if (typeof rawBody.error === 'string') {
          return rawBody.error;
        }
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

/**
 * Build an Error with `.status` and `.raw` attached for the HTTP failure
 * case. The label is included in the message (e.g. `[qwen]`, `[deepseek]`)
 * so logs / audit entries carry the provider name.
 *
 * @param {string} label  short provider label, e.g. 'qwen'
 * @param {unknown} raw   parsed response body (or whatever the fetch returned)
 * @param {number} status HTTP status code
 * @returns {Error}
 */
export function wrapHttpError(label, raw, status) {
  const msg = extractErrorMessage(raw, status);
  const err = new Error(`[${label}] HTTP ${status}: ${msg}`);
  err.status = status;
  err.raw = raw;
  return err;
}

/**
 * Build a reasoning-content extractor for OpenAI-compatible providers
 * that surface chain-of-thought via `choices[0].message.reasoning_content`.
 *
 * The two canonical vendor shapes:
 *   - DeepSeek R1:  field ABSENT (not present in the response object)
 *     -> callers want '' (so the surface stays uniform)
 *   - DashScope V3 (Qwen): field EXPLICITLY NULL
 *     -> callers want null (the honest wire shape — V8.1 commit message
 *        locked this in: "Qwen V3 emits `reasoning_content: null`,
 *        not the field being absent; `null` is the honest wire shape")
 *
 * Pick `onAbsent` to match the vendor: 'string' for DeepSeek V3-like
 * (field absent), 'null' for DashScope V3 (field explicitly null).
 *
 * Usage:
 *   const extractReasoning = makeExtractReasoning({ onAbsent: null });
 *   const reasoning = extractReasoning(raw);  // string | null
 *
 * @param {{onAbsent?: ''|null}} [opts]
 */
export function makeExtractReasoning(opts = {}) {
  const onAbsent = opts.onAbsent === null ? null : '';
  return function extractReasoning(raw) {
    try {
      if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) {
        return onAbsent;
      }
      const first = raw.choices[0];
      if (!first || typeof first !== 'object') {
        return onAbsent;
      }
      const m = first.message;
      if (!m || typeof m !== 'object') {
        return onAbsent;
      }
      // Field explicitly absent -> onAbsent (per vendor contract)
      if (!Object.prototype.hasOwnProperty.call(m, 'reasoning_content')) {
        return onAbsent;
      }
      // Field present but wrong type -> onAbsent (defensive)
      if (typeof m.reasoning_content !== 'string') {
        return onAbsent;
      }
      return m.reasoning_content;
    } catch {
      return onAbsent;
    }
  };
}

/**
 * Sanity-check that a base URL/path used as a chat-completions path
 * segment doesn't accidentally include double slashes or query strings.
 * Used by providers that build `${baseUrl}${CHAT_PATH}` (the
 * baseUrl-stripping already handles /v1, but this catches typos in
 * the CHAT_PATH constant).
 *
 * @param {string} baseUrl  already-stripped base URL (use normalizeBaseUrl first)
 * @param {string} chatPath  path like '/v1/chat/completions'
 * @returns {string}  safe join, e.g. 'https://api.example.com/v1/chat/completions'
 */
export function joinChatUrl(baseUrl, chatPath) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return '';
  }
  if (typeof chatPath !== 'string' || !chatPath.startsWith('/')) {
    return baseUrl;
  }
  // path.join collapses double slashes; preserves leading / on chatPath.
  return baseUrl + path.normalize(chatPath).replace(/\\/g, '/');
}

/**
 * Split accumulated text into {visible, reasoning} by <think>...</think> pairs.
 * V45: keeps <think>...</think> blocks out of the user-visible content;
 * exposes them via state.reasoning (alongside API-level reasoning_content).
 * An unclosed <think> is treated as reasoning (safe; never leaks partial
 * thinking). Returns {visible: string, reasoning: string}; both default
 * to '' on bad input.
 *
 * V45.1: lifted out of openai-compatible-stream.js so the chat path
 * (openai-compatible.js) can reuse it. Before this, the chat path
 * shipped `...` in the user-visible content because the stream-only
 * helper was the only place that stripped them.
 */
export function splitThinkBlocks(raw) {
  const out = { visible: '', reasoning: '' };
  if (typeof raw !== 'string' || raw.length === 0) {
    return out;
  }
  const openTag = '<think>';
  const closeTag = '</think>';
  let i = 0;
  while (i < raw.length) {
    const openIdx = raw.indexOf(openTag, i);
    if (openIdx === -1) {
      out.visible += raw.slice(i);
      return out;
    }
    out.visible += raw.slice(i, openIdx);
    const closeIdx = raw.indexOf(closeTag, openIdx + openTag.length);
    if (closeIdx === -1) {
      out.reasoning += raw.slice(openIdx + openTag.length);
      return out;
    }
    out.reasoning += raw.slice(openIdx + openTag.length, closeIdx);
    i = closeIdx + closeTag.length;
  }
  return out;
}
