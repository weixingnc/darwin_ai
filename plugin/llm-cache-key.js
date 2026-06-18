/**
 * llm-cache-key — deterministic key construction for the llm-cache
 * plugin (W6-2, 2026-06-18). Split from plugin/llm-cache.js to keep
 * the main plugin file under the 200-line convention.
 *
 * makeKey(messages, model) returns a 64-char hex SHA-256 hash of
 * (model + normalised messages). Same logical prompt in different
 * physical shapes (timestamp order, whitespace, volatile fields)
 * collides to the same key — that's the whole point.
 *
 * Normalisation rules (see normaliseMessage below):
 *   - drop leading/trailing whitespace in string content
 *   - sort tool_calls by id
 *   - keep only the structurally significant fields
 *   - everything else (timestamp, run_id, request id) is dropped
 *
 * stableStringify: deterministic JSON.stringify with sorted keys
 * at every depth. Without this, {a:1,b:2} and {b:2,a:1} would
 * produce different hashes.
 */

import { createHash } from 'node:crypto';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Strip volatile fields from a message before keying. */
export function normaliseMessage(m) {
  if (!m || typeof m !== 'object') {
    return m;
  }
  const out = { role: m.role };
  if (typeof m.content === 'string') {
    out.content = m.content.trim();
  } else if (m.content !== undefined) {
    out.content = m.content;
  }
  if (Array.isArray(m.tool_calls)) {
    out.tool_calls = [...m.tool_calls]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function && {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
  }
  if (m.name !== undefined) {
    out.name = m.name;
  }
  if (m.tool_call_id !== undefined) {
    out.tool_call_id = m.tool_call_id;
  }
  return out;
}

export function makeKey(messages, model) {
  const normMessages = Array.isArray(messages) ? messages.map(normaliseMessage) : [];
  const payload = stableStringify({
    model: String(model || ''),
    messages: normMessages,
  });
  return createHash('sha256').update(payload).digest('hex');
}
