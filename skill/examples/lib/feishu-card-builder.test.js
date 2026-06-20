/**
 * feishu-card-builder lib direct-import sanity tests (v10.6).
 *
 * The bulk of feishu-card coverage lives in skill/examples/feishu-card.test.js
 * (it imports buildCard/themeOf/fieldsOf via the skill wrapper's re-exports).
 * This file proves the lib module is independently importable + the
 * helper-level contract holds when called directly (not via buildCard).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseTheme,
  nonEmptyString,
  titleTextFor,
  noteTextFor,
  buildCard,
  themeOf,
  fieldsOf,
} from './feishu-card-builder.js';

describe('feishu-card-builder lib -- direct helper contract', () => {
  test('normaliseTheme: accepts valid themes, falls back on invalid', () => {
    assert.equal(normaliseTheme('green'), 'green');
    assert.equal(normaliseTheme('ORANGE'), 'orange');
    assert.equal(normaliseTheme('blue'), 'blue');
    assert.equal(normaliseTheme('red'), 'red');
    assert.equal(normaliseTheme('purple'), 'blue'); // unknown -> blue
    assert.equal(normaliseTheme(undefined), 'blue'); // non-string -> blue
    assert.equal(normaliseTheme(null), 'blue');
    assert.equal(normaliseTheme(42), 'blue');
  });

  test('nonEmptyString: returns string for non-empty, "" otherwise', () => {
    assert.equal(nonEmptyString('hello'), 'hello');
    assert.equal(nonEmptyString(''), '');
    assert.equal(nonEmptyString(null), '');
    assert.equal(nonEmptyString(undefined), '');
    assert.equal(nonEmptyString(42), '');
    assert.equal(nonEmptyString({}), '');
  });

  test('titleTextFor: apply:after prefers subject/tag, falls back to default', () => {
    assert.equal(titleTextFor('evolution:apply:after', { subject: 'feat(x)' }), 'feat(x)');
    assert.equal(titleTextFor('evolution:apply:after', { tag: 'v1.0' }), 'v1.0');
    assert.equal(titleTextFor('evolution:apply:after', {}), 'Darwin cycle \u6536\u53e3');
  });

  test('titleTextFor: audit uses proposal_id when present', () => {
    assert.equal(titleTextFor('evolution:audit', { proposal_id: 'p-7' }), 'Audit \u00b7 p-7');
    assert.equal(titleTextFor('evolution:audit', {}), 'Darwin audit');
  });

  test('noteTextFor: include Source prefix + action/outcome for audit', () => {
    assert.equal(
      noteTextFor('evolution:apply:after', {}),
      'Source: Darwin self-evolution cycle (apply:after)',
    );
    assert.equal(
      noteTextFor('evolution:audit', { action: 'apply', outcome: 'ok' }),
      'Source: Darwin evolution audit \u00b7 action=apply \u00b7 outcome=ok',
    );
  });

  test('buildCard: rich shape has output (string), card (object), theme, stats', () => {
    const r = buildCard({
      topic: 'evolution:audit',
      payload: { proposal_id: 'p-1', action: 'apply', outcome: 'ok' },
    });
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.length > 0);
    assert.equal(r.theme, 'green');
    assert.equal(r.stats.elements, 3);
    assert.equal(r.stats.has_header, true);
    assert.equal(r.card.header.template, 'green');
  });

  test('buildCard: invalid options.theme falls back to blue (via normaliseTheme)', () => {
    const r = buildCard({ topic: 'evolution:audit', payload: {} }, { theme: 'purple' });
    assert.equal(r.theme, 'blue');
  });

  test('themeOf/fieldsOf: exported and callable (used by plugin/feishu-notify)', () => {
    // These are the plugin reuse helpers -- verify they still work standalone.
    assert.equal(themeOf('evolution:apply:after', {}), 'green');
    assert.equal(themeOf('evolution:audit', { outcome: 'rolled_back' }), 'red');
    assert.equal(Array.isArray(fieldsOf('evolution:audit', {})), true);
    assert.equal(fieldsOf('evolution:audit', {}).length, 3);
  });
});
