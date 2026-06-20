/**
 * feishu-card — Darwin skill: build a Feishu interactive card JSON from
 * a Darwin evolution event payload (V7 cycle 1 P2-ext).
 *
 * v10.6: card-construction logic moved to ./lib/feishu-card-builder.js.
 * This file is now a thin skill wrapper (~40 lines): import buildCard,
 * define the execute() shape, re-export for plugin/feishu-notify.js
 * backward compat.
 *
 * ADR-009 mechanical stub -- NO LLM, NO external API. Pure deterministic
 * card construction. The plugin/feishu-notify.js caller can also import
 * `buildCard()` directly to compose a card, then push it via the
 * platform/feishu.js `send` action (V7.1 -- payload.card path, msg_type
 * = 'interactive').
 *
 * V8.2 contract details (execute shape split, migration guide, sibling
 * pattern alignment) live in docs/skill-contract.md. Read it before
 * changing the execute() return shape -- there are V8.2 guard tests that
 * lock the single-key `{ output: string }` contract.
 */

import { buildCard, nonEmptyString } from './lib/feishu-card-builder.js';

export const feishuCard = {
  name: 'feishu-card',
  description:
    'Build a Feishu interactive card JSON from a Darwin evolution event payload (v7 P2-ext). Execute returns stringified card; use buildCard() for structured access.',
  triggers: [
    'feishu card',
    'interactive card',
    'card message',
    '\u98de\u4e66\u5361\u7247',
    '\u4ea4\u4e92\u5361\u7247',
  ],
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
    // directly -- it returns the full `{ output, card, theme, stats }` shape.
    const built = buildCard({ topic, payload: event }, opts);
    return { output: built.output };
  },
};

// Re-export for backward compat with plugin/feishu-notify.js and existing
// skill/examples/feishu-card.test.js. New code should import from
// ./lib/feishu-card-builder.js directly.
export { buildCard } from './lib/feishu-card-builder.js';
export { themeOf, fieldsOf } from './lib/feishu-card-builder.js';
export default feishuCard;
