/**
 * feishu-card — Darwin skill: build a Feishu interactive card JSON from
 * a Darwin evolution event payload (V7 cycle 1 P2-ext).
 *
 * ADR-009 mechanical stub — NO LLM, NO external API. Pure deterministic
 * card construction. The plugin/feishu-notify.js caller can also import
 * `buildCard()` directly to compose a card, then push it via the
 * platform/feishu.js `send` action (V7.1 — payload.card path, msg_type
 * = 'interactive').
 *
 * Card shape follows the Feishu open-platform `interactive` card spec:
 *   {
 *     header: { title: { tag:'plain_text', content: string },
 *               template: 'green' | 'blue' | 'orange' | 'red' },
 *     elements: [
 *       { tag:'divider' },
 *       { tag:'div', fields: [{ is_short:boolean, text:{tag:'plain_text',content:string} }] },
 *       { tag:'note', elements: [{ tag:'plain_text', content: string }] }
 *     ]
 *   }
 *
 * Theme heuristic (when caller does NOT pass options.theme):
 *   - apply:after event  → 'green'  (cycle 收口 = success)
 *   - audit  outcome=ok  → 'green'
 *   - audit  outcome=warn / warning → 'orange'
 *   - audit  outcome=error / fail / failed → 'red'
 *   - audit  default     → 'blue'   (info)
 *
 * Theme overrides via options.theme: 'green' | 'blue' | 'orange' | 'red'.
 * Anything else is normalised to 'blue' and the original is logged to
 * stderr (best-effort; never throws).
 *
 * Exports:
 *   - feishuCard                — the skill (with execute()).
 *   - buildCard(input, options) — direct programmatic entry; returns the
 *       rich shape `{ output, card, theme, stats }`. Use this when you
 *       need the structured card object (e.g. plugin/feishu-notify).
 *   - themeOf(topic, payload)   — exported helper for plugin reuse.
 *   - fieldsOf(topic, payload)  — exported helper for plugin reuse.
 *
 * V8.2 contract details (execute shape split, migration guide, sibling
 * pattern alignment) live in docs/skill-contract.md. Read it before
 * changing the execute() return shape — there are V8.2 guard tests that
 * lock the single-key `{ output: string }` contract.
 */

import process from 'node:process';

const VALID_THEMES = ['green', 'blue', 'orange', 'red'];

function normaliseTheme(raw) {
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

function nonEmptyString(s) {
  return typeof s === 'string' && s.length > 0 ? s : '';
}

function titleTextFor(topic, payload) {
  if (topic === 'evolution:apply:after') {
    return (
      nonEmptyString(payload && payload.subject) ||
      nonEmptyString(payload && payload.tag) ||
      'Darwin cycle 收口'
    );
  }
  if (topic === 'evolution:audit') {
    const proposal = nonEmptyString(payload && payload.proposal_id);
    return proposal ? `Audit · ${proposal}` : 'Darwin audit';
  }
  return 'Darwin event';
}

function themeOf(topic, payload) {
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

function fieldsOf(topic, payload) {
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

function noteTextFor(topic, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (topic === 'evolution:apply:after') {
    return 'Source: Darwin self-evolution cycle (apply:after)';
  }
  if (topic === 'evolution:audit') {
    return `Source: Darwin evolution audit · action=${nonEmptyString(p.action) || '?'} · outcome=${nonEmptyString(p.outcome) || '?'}`;
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
 *                                proposal_id, action, outcome, …)
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
function buildCard(input, options = {}) {
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

export const feishuCard = {
  name: 'feishu-card',
  description:
    'Build a Feishu interactive card JSON from a Darwin evolution event payload (v7 P2-ext). Execute returns stringified card; use buildCard() for structured access.',
  triggers: ['feishu card', 'interactive card', 'card message', '飞书卡片', '交互卡片'],
  systemPromptHint:
    'User wants a Feishu interactive card. Build a card with header (color) + elements (fields/divider/note) per the event type.',
  async execute(input, context = {}) {
    const opts =
      context && typeof context.options === 'object' && context.options !== null
        ? context.options
        : {};
    const event = input && typeof input === 'object' ? input : {};
    const topic = nonEmptyString(event.topic) || nonEmptyString(event.kind) || 'evolution:unknown';
    // V8.2 single-key contract: skill execute() returns `{ output: string }`
    // parallel to hello-world / summarizer / translator. For programmatic
    // consumers that need the structured card object, import `buildCard()`
    // directly — it returns the full `{ output, card, theme, stats }` shape.
    const built = buildCard({ topic, payload: event }, opts);
    return { output: built.output };
  },
};

export { buildCard, themeOf, fieldsOf };
export default feishuCard;
