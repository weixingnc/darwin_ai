/** feishu-card skill tests — V7 cycle 1 (2026-06-19). ADR-009 mechanical stub. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feishuCard, buildCard, themeOf, fieldsOf } from './feishu-card.js';

describe('feishu-card — catalog contract', () => {
  test('name', () => assert.equal(feishuCard.name, 'feishu-card'));

  test('description is a non-empty string', () => {
    assert.equal(typeof feishuCard.description, 'string');
    assert.ok(feishuCard.description.length > 0);
  });

  test('triggers is an array with all expected phrases', () => {
    assert.ok(Array.isArray(feishuCard.triggers));
    for (const t of ['feishu card', 'interactive card', 'card message', '飞书卡片', '交互卡片']) {
      assert.ok(feishuCard.triggers.includes(t), `missing trigger: ${t}`);
    }
  });

  test('systemPromptHint is a non-empty string', () => {
    assert.equal(typeof feishuCard.systemPromptHint, 'string');
    assert.ok(feishuCard.systemPromptHint.length > 0);
  });

  test('execute() returns {output:string} single-key contract (V8.2)', async () => {
    const r = await feishuCard.execute({
      topic: 'evolution:apply:after',
      subject: 'V7.1',
      tag: 'tag-v7c1',
    });
    // V8.2 single-key: {output: string} parallel to hello-world / summarizer /
    // translator. Programmatic callers (plugin/feishu-notify) get the rich
    // shape via buildCard() import, not via execute().
    assert.equal(typeof r, 'object');
    assert.deepEqual(
      Object.keys(r).sort(),
      ['output'],
      'execute() must return single-key {output}',
    );
    assert.equal(typeof r.output, 'string');
    // The output string is JSON.stringify(card); round-trip parses to the
    // buildCard() card object so consumers can JSON.parse if they need to.
    const reparsed = JSON.parse(r.output);
    const built = buildCard({
      topic: 'evolution:apply:after',
      payload: { subject: 'V7.1', tag: 'tag-v7c1' },
    });
    assert.deepEqual(reparsed, built.card);
  });
});

describe('feishu-card — themeOf()', () => {
  test('apply:after → green (cycle 收口 = success)', () => {
    assert.equal(themeOf('evolution:apply:after', { subject: 'x' }), 'green');
  });

  test('audit commit / ok / success / applied → green', () => {
    for (const outcome of ['ok', 'success', 'commit', 'applied']) {
      assert.equal(
        themeOf('evolution:audit', { proposal_id: 'p', action: 'a', outcome }),
        'green',
        `outcome=${outcome}`,
      );
    }
  });

  test('audit warn / warning → orange', () => {
    for (const outcome of ['warn', 'warning']) {
      assert.equal(
        themeOf('evolution:audit', { proposal_id: 'p', action: 'a', outcome }),
        'orange',
        `outcome=${outcome}`,
      );
    }
  });

  test('audit error / fail / failed / rolled_back → red', () => {
    for (const outcome of ['error', 'fail', 'failed', 'rolled_back']) {
      assert.equal(
        themeOf('evolution:audit', { proposal_id: 'p', action: 'a', outcome }),
        'red',
        `outcome=${outcome}`,
      );
    }
  });

  test('audit unknown outcome → blue (info)', () => {
    assert.equal(
      themeOf('evolution:audit', { proposal_id: 'p', action: 'a', outcome: 'whatever' }),
      'blue',
    );
  });

  test('unknown topic → blue (info, default)', () => {
    assert.equal(themeOf('evolution:something-else', {}), 'blue');
  });
});

describe('feishu-card — buildCard()', () => {
  test('apply:after → header.template === "green"', () => {
    const { card } = buildCard({ topic: 'evolution:apply:after', payload: { subject: 'x' } });
    assert.equal(card.header.template, 'green');
  });

  test('audit commit → header.template === "green"', () => {
    const { card } = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'p', action: 'apply', outcome: 'commit' },
    });
    assert.equal(card.header.template, 'green');
  });

  test('audit warn → header.template === "orange"', () => {
    const { card } = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'p', action: 'audit', outcome: 'warn' },
    });
    assert.equal(card.header.template, 'orange');
  });

  test('audit error → header.template === "red"', () => {
    const { card } = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'p', action: 'apply', outcome: 'error' },
    });
    assert.equal(card.header.template, 'red');
  });

  test('options.theme override takes precedence over inferred', () => {
    const { theme, card } = buildCard(
      { topic: 'evolution:apply:after', payload: { subject: 'x' } },
      { theme: 'red' },
    );
    assert.equal(theme, 'red');
    assert.equal(card.header.template, 'red');
  });

  test('options.theme with invalid value falls back to blue (no throw)', () => {
    const { theme, card } = buildCard(
      { topic: 'evolution:apply:after', payload: { subject: 'x' } },
      { theme: 'magenta-not-a-real-color' },
    );
    assert.equal(theme, 'blue');
    assert.equal(card.header.template, 'blue');
  });

  test('output is JSON.stringify(card) — round-trip parses to same object', () => {
    const { output, card } = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'p1', action: 'apply', outcome: 'ok' },
    });
    const reparsed = JSON.parse(output);
    assert.deepEqual(reparsed, card);
  });

  test('apply:after elements contain divider + fields + note', () => {
    const { card } = buildCard({
      topic: 'evolution:apply:after',
      payload: { subject: 'tag-x', tag: 'v7-c1' },
    });
    const tags = card.elements.map((e) => e.tag);
    assert.ok(tags.includes('divider'), 'must contain a divider');
    assert.ok(tags.includes('div'), 'must contain a div with fields');
    assert.ok(tags.includes('note'), 'must contain a note');
    const fields = card.elements.find((e) => e.tag === 'div').fields;
    assert.ok(Array.isArray(fields) && fields.length >= 2, 'must have at least 2 fields');
    // subject + tag fields are mandatory
    const fieldText = fields.map((f) => f.text.content).join(' | ');
    assert.match(fieldText, /subject: tag-x/);
    assert.match(fieldText, /tag: v7-c1/);
  });

  test('apply:after with commit_sha and ts shows them in fields', () => {
    const { card } = buildCard({
      topic: 'evolution:apply:after',
      payload: { subject: 'x', tag: 't', commit_sha: 'abc123', ts: '2026-06-19T10:00:00Z' },
    });
    const fields = card.elements.find((e) => e.tag === 'div').fields;
    const fieldText = fields.map((f) => f.text.content).join(' | ');
    assert.match(fieldText, /commit_sha: abc123/);
    assert.match(fieldText, /ts: 2026-06-19T10:00:00Z/);
  });

  test('audit elements contain proposal_id / action / outcome in fields', () => {
    const { card } = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'prop-001', action: 'apply', outcome: 'success' },
    });
    const fields = card.elements.find((e) => e.tag === 'div').fields;
    const fieldText = fields.map((f) => f.text.content).join(' | ');
    assert.match(fieldText, /proposal_id: prop-001/);
    assert.match(fieldText, /action: apply/);
    assert.match(fieldText, /outcome: success/);
  });

  test('empty payload does not throw — card has empty subject / n/a fields', () => {
    const r = buildCard({ topic: 'evolution:apply:after', payload: {} });
    assert.equal(r.card.header.template, 'green');
    const fields = r.card.elements.find((e) => e.tag === 'div').fields;
    // Either "subject: n/a" or similar — must not throw and must be array.
    assert.ok(Array.isArray(fields));
  });

  test('fieldsOf() returns at least one field for known topics', () => {
    assert.ok(fieldsOf('evolution:apply:after', { subject: 'x', tag: 't' }).length >= 2);
    assert.ok(
      fieldsOf('evolution:audit', { proposal_id: 'p', action: 'a', outcome: 'o' }).length >= 2,
    );
  });
});

describe('feishu-card — execute() input guards', () => {
  test('execute() with no input still produces a card (graceful default)', async () => {
    const r = await feishuCard.execute();
    // V8.2 single-key: only `output` key
    assert.equal(typeof r.output, 'string');
    assert.deepEqual(Object.keys(r).sort(), ['output']);
    // round-trip: parse and verify default blue theme is on the card header
    const reparsed = JSON.parse(r.output);
    assert.equal(reparsed.header.template, 'blue');
  });

  test('execute() with null input still produces a card', async () => {
    const r = await feishuCard.execute(null);
    assert.equal(typeof r.output, 'string');
    assert.deepEqual(Object.keys(r).sort(), ['output']);
  });

  test('execute() with non-object input coerces via topic="evolution:unknown" → blue', async () => {
    const r = await feishuCard.execute('not an object');
    assert.equal(typeof r.output, 'string');
    const reparsed = JSON.parse(r.output);
    assert.equal(reparsed.header.template, 'blue');
  });

  test('execute() with context.options.theme forwards to buildCard', async () => {
    const r = await feishuCard.execute(
      { topic: 'evolution:apply:after', subject: 'x' },
      { options: { theme: 'red' } },
    );
    const reparsed = JSON.parse(r.output);
    assert.equal(reparsed.header.template, 'red');
  });

  test('execute() does NOT expose card/theme/stats keys (single-key contract)', async () => {
    // V8.2 guard: ensure execute() does not regress to multi-key. If we add
    // back card/theme/stats in execute(), this test will fail and force a
    // V8.2-aware redesign.
    const r = await feishuCard.execute({
      topic: 'evolution:apply:after',
      subject: 'x',
    });
    assert.equal(r.card, undefined, 'execute() must not return card');
    assert.equal(r.theme, undefined, 'execute() must not return theme');
    assert.equal(r.stats, undefined, 'execute() must not return stats');
  });
});
