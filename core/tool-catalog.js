// core/tool-catalog.js — PR-24: Tool Catalog + 3 Meta Tool
// Design: docs/PR_DESIGN_23_24_25.md §PR-24
// Reference: docs/OPENCLAW_PROMPT_REFERENCE.md §3 (3 meta tool 抄 3 个, code 模式 v1 不做)
//
// Exports:
//   5 functions: registerTool, unregisterTool, searchTools, describeTool, callTool
//   3 meta tool schemas: META_TOOL_SCHEMAS (tool_search / tool_describe / tool_call)
//   4 error codes: TOOL_NOT_FOUND, INVALID_ARGS, HANDLER_ERROR, TIMEOUT
//   1 helper: validateArgs (minimal JSON Schema check, no ajv/zod)

// Tool error codes (PR-24 final, normalized for PR-25).
// Old names kept as aliases for backward compat with PR-24 tests.
export const TOOL_NOT_FOUND = 'TOOL_NOT_FOUND';
export const TOOL_INVALID_ARGS = 'TOOL_INVALID_ARGS';
export const TOOL_EXEC_FAILED = 'TOOL_EXEC_FAILED';
export const TIMEOUT = 'TIMEOUT';

// PR-24 aliases (deprecated but not removed)
export const INVALID_ARGS = TOOL_INVALID_ARGS;
export const HANDLER_ERROR = TOOL_EXEC_FAILED;

export const META_TOOL_NAMES = Object.freeze({
  SEARCH: 'tool_search',
  DESCRIBE: 'tool_describe',
  CALL: 'tool_call',
});

// Minimal JSON Schema validator: type / required / properties.type / properties.enum
// Returns { ok:true } or { ok:false, message }. No throws.
export function validateArgs(args, schema) {
  if (schema === null || schema === undefined) {
    return { ok: true };
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, message: 'args must be a plain object' };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in args)) {
      return { ok: false, message: `missing required '${key}'` };
    }
  }
  const props = schema.properties || {};
  for (const [key, val] of Object.entries(args)) {
    const err = checkProp(key, val, props[key]);
    if (err) {
      return { ok: false, message: err };
    }
  }
  return { ok: true };
}

function checkProp(key, val, rule) {
  if (!rule) {
    return null;
  } // extra props allowed
  const expected = rule.type;
  if (!expected) {
    return null;
  }
  if (!typeMatches(val, expected)) {
    return `'${key}' must be ${expected}, got ${jsTypeOf(val)}`;
  }
  if (Array.isArray(rule.enum) && !rule.enum.includes(val)) {
    return `'${key}' must be one of ${JSON.stringify(rule.enum)}`;
  }
  return null;
}

function typeMatches(val, expected) {
  if (expected === 'string') {
    return typeof val === 'string';
  }
  if (expected === 'number') {
    return typeof val === 'number' && Number.isFinite(val);
  }
  if (expected === 'integer') {
    return typeof val === 'number' && Number.isInteger(val);
  }
  if (expected === 'boolean') {
    return typeof val === 'boolean';
  }
  if (expected === 'object') {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }
  if (expected === 'array') {
    return Array.isArray(val);
  }
  return true; // unknown type → permissive
}

function jsTypeOf(val) {
  if (val === null) {
    return 'null';
  }
  if (Array.isArray(val)) {
    return 'array';
  }
  return typeof val;
}

// Create a new (empty) catalog. Pure: caller owns it.
export function createCatalog() {
  return new Map();
}

// Register a tool. If name already exists, higher priority wins; equal priority → first wins.
export function registerTool(catalog, entry) {
  assertCatalog(catalog);
  assertEntry(entry);
  const incomingPrio = Number.isFinite(entry.priority) ? entry.priority : 0;
  const existing = catalog.get(entry.name);
  if (existing) {
    const existingPrio = Number.isFinite(existing.priority) ? existing.priority : 0;
    if (incomingPrio <= existingPrio) {
      return { ok: false, reason: 'lower_or_equal_priority', kept: existing };
    }
  }
  const frozen = buildEntry(entry, incomingPrio);
  catalog.set(entry.name, frozen);
  return { ok: true, entry: frozen };
}

function assertCatalog(catalog) {
  if (!catalog || !(catalog instanceof Map)) {
    throw new TypeError('catalog must be a Map from createCatalog()');
  }
}

function assertEntry(entry) {
  if (!entry || typeof entry.name !== 'string' || !entry.name) {
    throw new TypeError('entry.name is required');
  }
  // PR-24 minor 3: accept `execute` (design) or `handler` (PR-24 v1).
  const fn = typeof entry.execute === 'function' ? entry.execute : entry.handler;
  if (typeof fn !== 'function') {
    throw new TypeError(`entry.execute (or handler) for '${entry.name}' must be a function`);
  }
}

function buildEntry(entry, priority) {
  // PR-24 minor 3: accept design fields `parameters`/`execute`/`fallback`, fallback to PR-24 v1 names.
  const parameters = entry.parameters || entry.schema || { type: 'object', properties: {} };
  const execute = typeof entry.execute === 'function' ? entry.execute : entry.handler;
  const fallback = Array.isArray(entry.fallback) ? [...entry.fallback] : [];
  return Object.freeze({
    name: entry.name,
    summary: String(entry.summary || entry.name),
    description: String(entry.description || entry.summary || entry.name),
    category: String(entry.category || 'general'),
    parameters: Object.freeze(parameters),
    schema: parameters, // PR-24 v1 compat alias
    version: String(entry.version || '0.0.0'),
    source: String(entry.source || 'manual'),
    priority,
    handler: execute,
    execute,
    fallback: Object.freeze(fallback),
  });
}

export function unregisterTool(catalog, name) {
  if (!catalog || !(catalog instanceof Map)) {
    return false;
  }
  return catalog.delete(name);
}

// Substring + case-insensitive across name + summary + category. Priority desc, then name asc.
export function searchTools(catalog, { query = '', max } = {}) {
  if (!catalog) {
    return [];
  }
  const q = String(query || '')
    .toLowerCase()
    .trim();
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
  const all = [];
  for (const entry of catalog.values()) {
    if (!q) {
      all.push({ entry, score: 0 });
      continue;
    }
    const hay = `${entry.name} ${entry.summary} ${entry.category}`.toLowerCase();
    if (hay.includes(q)) {
      // Simple score: name-hit > summary-hit > category-hit; longer name match = higher.
      let score = 1;
      if (entry.name.toLowerCase().includes(q)) {
        score += 2;
      }
      if (entry.summary.toLowerCase().includes(q)) {
        score += 1;
      }
      score += q.length / 100; // tiebreak
      all.push({ entry, score });
    }
  }
  all.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.entry.name.localeCompare(b.entry.name);
  });
  return all.slice(0, limit).map((x) => ({
    name: x.entry.name,
    summary: x.entry.summary,
    category: x.entry.category,
    score: Number(x.score.toFixed(3)),
  }));
}

// Returns full schema WITHOUT handler (脱敏). On miss: { ok:false, errorCode:TOOL_NOT_FOUND }.
export function describeTool(catalog, name) {
  if (!catalog) {
    return { ok: false, errorCode: TOOL_NOT_FOUND };
  }
  const entry = catalog.get(name);
  if (!entry) {
    return { ok: false, errorCode: TOOL_NOT_FOUND };
  }
  return {
    ok: true,
    tool: {
      name: entry.name,
      summary: entry.summary,
      description: entry.description,
      parameters: entry.parameters,
      schema: entry.parameters,
      category: entry.category,
      version: entry.version,
      source: entry.source,
      fallback: entry.fallback || [],
    },
  };
}

// Validate args, then invoke handler with try/catch. NEVER throws.
export async function callTool(catalog, name, args, ctx) {
  if (!catalog) {
    return { ok: false, errorCode: TOOL_NOT_FOUND, error: 'catalog unavailable' };
  }
  const entry = catalog.get(name);
  if (!entry) {
    return { ok: false, errorCode: TOOL_NOT_FOUND, error: `tool '${name}' not in catalog` };
  }
  const check = validateArgs(args || {}, entry.parameters || entry.schema);
  if (!check.ok) {
    return { ok: false, errorCode: TOOL_INVALID_ARGS, error: check.message };
  }
  if (ctx && ctx.signal && ctx.signal.aborted) {
    return { ok: false, errorCode: TIMEOUT, error: 'aborted before invoke' };
  }
  try {
    const fn = entry.execute || entry.handler;
    const result = await fn(args || {}, ctx || {});
    return { ok: true, result };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, errorCode: TOOL_EXEC_FAILED, error: message };
  }
}

// 3 meta tool JSON Schemas (function-calling compatible, OpenAI/Anthropic 都吃)
export const META_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: META_TOOL_NAMES.SEARCH,
    description: 'Search the tool catalog by keyword. Returns matching tool names + summaries.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({
          type: 'string',
          description: 'Search keyword (case-insensitive substring)',
        }),
        max: Object.freeze({
          type: 'integer',
          description: 'Max results (optional)',
          minimum: 1,
          maximum: 50,
        }),
      }),
      required: Object.freeze(['query']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: META_TOOL_NAMES.DESCRIBE,
    description: 'Load the full schema and metadata for one tool. Does NOT return the handler.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Tool name (must be registered)' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: META_TOOL_NAMES.CALL,
    description:
      'Invoke a registered tool by name with args. Returns {ok,result} or {ok:false,errorCode,error}.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Tool name' }),
        args: Object.freeze({
          type: 'object',
          description: 'Args object (validated against tool schema)',
        }),
      }),
      required: Object.freeze(['name', 'args']),
      additionalProperties: false,
    }),
  }),
]);

export const _internal = { typeMatches, jsTypeOf };
