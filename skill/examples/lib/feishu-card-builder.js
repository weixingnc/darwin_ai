/**
 * feishu-card-builder — pure deterministic Feishu interactive card builder.
 *
 * Extracted from skill/examples/feishu-card.js in v10.6 so the skill
 * wrapper stays a thin shell (just the execute() shape) and the card-
 * construction logic is independently testable + reusable.
 *
 * ADR-009 mechanical stub — NO LLM, NO external API. Pure deterministic.
 *
 * Card shape (Feishu open-platform `interactive` spec):
 *   {
 *     header: { title: { tag:'plain_text', content: string },
 *               template: 'green' | 'blue' | 'orange' | 'red' },
 *     elements: [
 *       { tag:'divider' },
 *       { tag:'div', fields: [{ is_short:boolean, text:{...} }] },
 *       { tag:'note', elements: [{ tag:'plain_text', content: string }] }
 *     ]
 *   }
 *
 * Theme heuristic (when caller does NOT pass options.theme):
 *   - apply:after event   -> green  (cycle 收口 = success)
 *   - audit  outcome=ok   -> green
 *   - audit  outcome=warn -> orange
 *   - audit  outcome=err  -> red
 *   - audit  default      -> blue   (info)
 *
 * Exports:
 *   - buildCard(input, options)  — programmatic entry; rich shape
 *       { output, card, theme, stats }
 *   - themeOf(topic, payload)    — theme heuristic (exported for plugin reuse)
 *   - fieldsOf(topic, payload)   — fields composition (exported for plugin reuse)
 *   - titleTextFor, noteTextFor, normaliseTheme, nonEmptyString
 *       — internal helpers, exported for direct unit testing
 */

import process from 'node:process';

const VALID_THEMES = ['green', 'blue', 'orange', 'red'];

export function normaliseTheme(raw) {
  if (typeof raw !== 'string') {
    return 'blue';
  }
  const lower = raw.toLowerCase();
  if (VALID_THEMES.includes(lower)) {
    return lower;
  }
  process.stderr.write(
    `[feishu-card] options.theme '${raw}' invalid, falling back to 'blue' ` +
      `(valid: ${VALID_THEMES.join(',')})\n`,
  );
  return 'blue';
}

export function nonEmptyString(s) {
  return typeof s === 'string' && s.length > 0 ? s : '';
}

export function titleTextFor(topic, payload) {
  if (topic === 'evolution:apply:after') {
    return (
      nonEmptyString(payload && payload.subject) ||
      nonEmptyString(payload && payload.tag) ||
      'Darwin cycle \u6536\u53e3'
    );
  }
  if (topic === 'evolution:audit') {
    const proposal = nonEmptyString(payload && payload.proposal_id);
    return proposal ? `Audit \u00b7 ${proposal}` : 'Darwin audit';
  }
  return 'Darwin event';
}

export function themeOf(topic, payload) {
  if (topic === 'evolution:apply:after') {
    return 'green';
  }
  if (topic === 'evolution:audit') {
    const outcome = nonEmptyString(payload && payload.outcome).toLowerCase();
    if (
      outcome === 'ok' ||
      outcome === 'success' ||
      outcome === 'commit' ||
      outcome === 'applied'
    ) {
      return 'green';
    }
    if (outcome === 'warn' || outcome === 'warning') {
      return 'orange';
    }
    if (
      outcome === 'error' ||
      outcome === 'fail' ||
      outcome === 'failed' ||
      outcome === 'rolled_back'
    ) {
      return 'red';
    }
    return 'blue';
  }
  return 'blue';
}

export function fieldsOf(topic, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (topic === 'evolution:apply:after') {
    const out = [
      {
        is_short: true,
        text: { tag: 'plain_text', content: `subject: ${nonEmptyString(p.subject) || 'n/a'}` },
      },
      {
        is_short: true,
        text: { tag: 'plain_text', content: `tag: ${nonEmptyString(p.tag) || 'n/a'}` },
      },
    ];
    if (p.commit_sha) {
      out.push({
        is_short: false,
        text: { tag: 'plain_text', content: `commit_sha: ${nonEmptyString(p.commit_sha)}` },
      });
    }
    if (p.ts) {
      out.push({
        is_short: false,
        text: { tag: 'plain_text', content: `ts: ${nonEmptyString(p.ts)}` },
      });
    }
    return out;
  }
  if (topic === 'evolution:audit') {
    return [
      {
        is_short: false,
        text: {
          tag: 'plain_text',
          content: `proposal_id: ${nonEmptyString(p.proposal_id) || 'n/a'}`,
        },
      },
      {
        is_short: true,
        text: { tag: 'plain_text', content: `action: ${nonEmptyString(p.action) || 'n/a'}` },
      },
      {
        is_short: true,
        text: { tag: 'plain_text', content: `outcome: ${nonEmptyString(p.outcome) || 'n/a'}` },
      },
    ];
  }
  return [
    {
      is_short: false,
      text: { tag: 'plain_text', content: `topic: ${topic || 'unknown'}` },
    },
  ];
}

export function noteTextFor(topic, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (topic === 'evolution:apply:after') {
    return 'Source: Darwin self-evolution cycle (apply:after)';
  }
  if (topic === 'evolution:audit') {
    return `Source: Darwin evolution audit \u00b7 action=${nonEmptyString(p.action) || '?'} \u00b7 outcome=${nonEmptyString(p.outcome) || '?'}`;
  }
  return 'Source: Darwin event';
}

/**
 * Build a Feishu interactive card from a Darwin evolution event.
 *
 * V8.2 contract: `buildCard()` is the programmatic entry point that returns
 * the rich shape. Skill `execute()` returns only `{ output: string }` (single
 * key, parallel to hello-world / summarizer / translator). Callers needing
 * the structured card object should import `buildCard()` directly — this
 * is the path `plugin/feishu-notify.js` uses (V7.1).
 *
 * @param {object} input
 * @param {'evolution:apply:after'|'evolution:audit'|string} input.topic
 * @param {object} input.payload  the event payload (subject, tag,
 *                                proposal_id, action, outcome, ...)
 * @param {object} [options]
 * @param {'green'|'blue'|'orange'|'red'} [options.theme]  override theme
 * @param {string} [options.title]                          override title
 * @param {string} [options.note]                           override note
 * @returns {{
 *   output: string,
 *   card: { header: object, elements: object[] },
 *   theme: string,
 *   stats: { elements: number, has_header: boolean }
 * }}
 */
export function buildCard(input, options = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  const topic = nonEmptyString(inp.topic) || 'evolution:unknown';
  const payload = inp.payload && typeof inp.payload === 'object' ? inp.payload : {};

  const explicit = options && options.theme;
  const theme = explicit ? normaliseTheme(explicit) : themeOf(topic, payload);
  const title = (options && nonEmptyString(options.title)) || titleTextFor(topic, payload);
  const note = (options && nonEmptyString(options.note)) || noteTextFor(topic, payload);

  const card = {
    header: {
      title: { tag: 'plain_text', content: title },
      template: theme,
    },
    elements: [
      { tag: 'divider' },
      { tag: 'div', fields: fieldsOf(topic, payload) },
      { tag: 'note', elements: [{ tag: 'plain_text', content: note }] },
    ],
  };

  return {
    output: JSON.stringify(card),
    card,
    theme,
    stats: { elements: card.elements.length, has_header: true },
  };
}
