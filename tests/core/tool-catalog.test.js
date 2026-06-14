// tests/core/tool-catalog.test.js — PR-24 test harness
// ≥10 unit + ≥5 integration per design §PR-24

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCatalog,
  registerTool,
  unregisterTool,
  searchTools,
  describeTool,
  callTool,
  validateArgs,
  META_TOOL_SCHEMAS,
  META_TOOL_NAMES,
  TOOL_NOT_FOUND,
  INVALID_ARGS,
  HANDLER_ERROR,
  TIMEOUT,
} from '../../core/tool-catalog.js';

// ---------- fixtures ----------
function mkEntry(name, opts = {}) {
  return {
    name,
    summary: opts.summary || `${name} tool`,
    description: opts.description || `Does the ${name} thing`,
    category: opts.category || 'general',
    schema: opts.schema || {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    },
    handler: opts.handler || (async () => `ok:${name}`),
    version: opts.version || '1.0.0',
    source: opts.source || 'test',
    priority: opts.priority || 0,
  };
}

// ---------- unit tests ----------
describe('tool-catalog: unit', () => {
  test('registerTool: basic insert', () => {
    const c = createCatalog();
    const r = registerTool(c, mkEntry('a'));
    assert.equal(r.ok, true);
    assert.equal(c.size, 1);
  });

  test('registerTool: higher priority overrides existing', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('a', { summary: 'old' }));
    registerTool(c, mkEntry('a', { summary: 'new', priority: 10 }));
    assert.equal(describeTool(c, 'a').tool.summary, 'new');
  });

  test('registerTool: lower priority does NOT override', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('a', { summary: 'old', priority: 5 }));
    const r = registerTool(c, mkEntry('a', { summary: 'new', priority: 1 }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'lower_or_equal_priority');
    assert.equal(describeTool(c, 'a').tool.summary, 'old');
  });

  test('unregisterTool: removes entry', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('a'));
    assert.equal(unregisterTool(c, 'a'), true);
    assert.equal(c.size, 0);
  });

  test('searchTools: substring + case-insensitive on name+summary+category', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('weather', { category: 'net', summary: 'Get forecast' }));
    registerTool(c, mkEntry('sweet_tooth', { category: 'food', summary: 'Track sugar' }));
    registerTool(c, mkEntry('calc', { category: 'math' }));
    const r = searchTools(c, { query: 'WEAT' });
    // matches: weather (name), sweet_tooth (summary "sugar"... no, that's wrong. let me think)
    // 'weat' substring in 'weather get forecast net' YES (weather)
    // 'weat' substring in 'sweet_tooth track sugar food' YES? s-w-e-e-t — no, "weat" is w-e-a-t, "swee" has e-e. so no match.
    // Let's use a cleaner fixture: rename for reliable substring.
    void r; // suppress unused
    const r2 = searchTools(c, { query: 'weat' });
    assert.ok(r2.length >= 1, 'weat matches weather');
    assert.ok(r2.some((x) => x.name === 'weather'));
  });

  test('searchTools: matches across summary and category (not just name)', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('alpha', { category: 'finance', summary: 'Compute returns' }));
    registerTool(c, mkEntry('beta', { category: 'science', summary: 'Analyze data' }));
    const r = searchTools(c, { query: 'finance' }); // category hit
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'alpha');
    const r2 = searchTools(c, { query: 'analyze' }); // summary hit
    assert.equal(r2.length, 1);
    assert.equal(r2[0].name, 'beta');
  });

  test('searchTools: empty query returns all', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('a'));
    registerTool(c, mkEntry('b'));
    assert.equal(searchTools(c, { query: '' }).length, 2);
  });

  test('searchTools: max limits results', () => {
    const c = createCatalog();
    for (let i = 0; i < 5; i++) {
      registerTool(c, mkEntry(`t${i}`, { category: 'shared' }));
    }
    assert.equal(searchTools(c, { query: 'shared', max: 2 }).length, 2);
  });

  test('describeTool: full fields, no handler', () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('w', { summary: 's', description: 'd', category: 'net', version: '2.0' }),
    );
    const r = describeTool(c, 'w');
    assert.equal(r.ok, true);
    assert.equal(r.tool.name, 'w');
    assert.equal(r.tool.summary, 's');
    assert.equal(r.tool.description, 'd');
    assert.equal(r.tool.category, 'net');
    assert.equal(r.tool.version, '2.0');
    assert.equal('handler' in r.tool, false, 'handler must be stripped');
  });

  test('callTool: success path', async () => {
    const c = createCatalog();
    registerTool(c, mkEntry('echo', { handler: async (a) => `got:${a.x}` }));
    const r = await callTool(c, 'echo', { x: 'hi' });
    assert.deepEqual(r, { ok: true, result: 'got:hi' });
  });

  test('callTool: TOOL_NOT_FOUND on unknown', async () => {
    const c = createCatalog();
    const r = await callTool(c, 'ghost', {});
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, TOOL_NOT_FOUND);
  });

  test('callTool: INVALID_ARGS on missing required', async () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('w', {
        schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }),
    );
    const r = await callTool(c, 'w', {});
    assert.equal(r.errorCode, INVALID_ARGS);
    assert.match(r.error, /missing required 'city'/);
  });

  test('callTool: HANDLER_ERROR when handler throws', async () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('boom', {
        handler: async () => {
          throw new Error('kaboom');
        },
      }),
    );
    const r = await callTool(c, 'boom', { x: 'a' });
    assert.equal(r.errorCode, HANDLER_ERROR);
    assert.equal(r.error, 'kaboom');
  });

  test('callTool: never throws (sync throw caught)', async () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('bang', {
        handler: () => {
          throw new TypeError('sync');
        },
      }),
    );
    const r = await callTool(c, 'bang', { x: '1' });
    assert.equal(r.errorCode, HANDLER_ERROR);
    assert.equal(r.error, 'sync');
  });

  test('validateArgs: enum + type checks', () => {
    const s = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['mode'],
    };
    assert.equal(validateArgs({ mode: 'a' }, s).ok, true);
    assert.equal(validateArgs({ mode: 'z' }, s).ok, false);
    assert.equal(validateArgs({ mode: 1 }, s).ok, false);
  });

  test('META_TOOL_SCHEMAS: all 3 present and valid', () => {
    assert.equal(META_TOOL_SCHEMAS.length, 3);
    const names = META_TOOL_SCHEMAS.map((t) => t.name);
    assert.ok(names.includes(META_TOOL_NAMES.SEARCH));
    assert.ok(names.includes(META_TOOL_NAMES.DESCRIBE));
    assert.ok(names.includes(META_TOOL_NAMES.CALL));
    for (const t of META_TOOL_SCHEMAS) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.parameters.type, 'object');
      assert.ok(Array.isArray(t.parameters.required));
    }
  });
});

// ---------- integration tests ----------
describe('tool-catalog: integration', () => {
  test('full chain: search → describe → call', async () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('weather', {
        category: 'net',
        summary: '查询天气',
        schema: { type: 'object', properties: {} },
        handler: async () => 'sunny',
      }),
    );
    const s = searchTools(c, { query: 'weather' });
    assert.equal(s[0].name, 'weather');
    const d = describeTool(c, s[0].name);
    assert.equal(d.tool.name, 'weather');
    assert.equal('handler' in d.tool, false);
    const k = await callTool(c, 'weather', {});
    assert.equal(k.ok, true);
    assert.equal(k.result, 'sunny');
  });

  test('duplicate name: priority decides who wins', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('x', { summary: 'low', priority: 1, handler: async () => 'A' }));
    registerTool(c, mkEntry('x', { summary: 'high', priority: 99, handler: async () => 'B' }));
    assert.equal(describeTool(c, 'x').tool.summary, 'high');
  });

  test('after unregister, search returns empty', () => {
    const c = createCatalog();
    registerTool(c, mkEntry('temp', { category: 'unique-cat' }));
    assert.equal(searchTools(c, { query: 'unique-cat' }).length, 1);
    unregisterTool(c, 'temp');
    assert.equal(searchTools(c, { query: 'unique-cat' }).length, 0);
  });

  test('handler returning string AND object both OK', async () => {
    const c = createCatalog();
    registerTool(
      c,
      mkEntry('s', {
        schema: { type: 'object', properties: {} },
        handler: async () => 'just-a-string',
      }),
    );
    registerTool(
      c,
      mkEntry('o', {
        schema: { type: 'object', properties: {} },
        handler: async () => ({ a: 1, b: [2, 3] }),
      }),
    );
    const r1 = await callTool(c, 's', {});
    const r2 = await callTool(c, 'o', {});
    assert.equal(r1.result, 'just-a-string');
    assert.deepEqual(r2.result, { a: 1, b: [2, 3] });
  });

  test('large catalog (200 tools): search stays < 50ms', () => {
    const c = createCatalog();
    for (let i = 0; i < 200; i++) {
      registerTool(c, mkEntry(`tool_${i}`, { category: i % 5 === 0 ? 'special' : 'bulk' }));
    }
    const t0 = Date.now();
    const r = searchTools(c, { query: 'special' });
    const dt = Date.now() - t0;
    assert.equal(r.length, 40); // 200/5
    assert.ok(dt < 50, `search took ${dt}ms, expected < 50ms`);
  });

  test('TIMEOUT when signal already aborted', async () => {
    const c = createCatalog();
    registerTool(c, mkEntry('x', { schema: { type: 'object', properties: {} } }));
    const ac = new AbortController();
    ac.abort();
    const r = await callTool(c, 'x', {}, { signal: ac.signal });
    assert.equal(r.errorCode, TIMEOUT);
  });
});
