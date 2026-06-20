/**
 * random-quote.mjs -- A custom skill that returns a random quote.
 *
 * Demonstrates:
 *   1. The minimal IPlugin contract for a skill (name + execute)
 *   2. Loading a skill via Darwin's skill registry + EventBus
 *   3. Triggering a skill and reading the result
 *
 * Use it from the bin/darwin CLI:
 *   node bin/darwin chat "give me a quote"   # if the chat flow
 *                                              # happens to fire
 *                                              # this skill's trigger
 *
 * Or programmatically:
 *   import { createRandomQuoteSkill } from './random-quote.mjs';
 *   const skill = createRandomQuoteSkill();
 *   const r = await skill.execute('hello');
 *   console.log(r.output);
 */

const QUOTES = [
  'The best way to predict the future is to invent it. -- Alan Kay',
  'Simplicity is the ultimate sophistication. -- Leonardo da Vinci',
  'Programs must be written for people to read. -- Harold Abelson',
  'Premature optimization is the root of all evil. -- Donald Knuth',
  'Make it work, make it right, make it fast. -- Kent Beck',
];

export function createRandomQuoteSkill() {
  return {
    // Required: stable name (the loader matches on this)
    name: 'random-quote',
    // Required: human-readable description (used in systemPromptHint wiring)
    description: 'Returns a randomly selected quote from a curated list.',
    // Optional: trigger words (Darwin uses these for skill matching)
    triggers: ['quote', 'inspiration', 'motivation', '\u9f13\u52b1'],
    // Optional: hint surfaced to the LLM when this skill is loaded
    systemPromptHint: 'User wants a quote. Call random-quote.execute() and return the output as-is.',
    // Required: async execute(input, context) -> { output: string }
    async execute(_input, _context) {
      const idx = Math.floor(Math.random() * QUOTES.length);
      return { output: QUOTES[idx] };
    },
  };
}

export default createRandomQuoteSkill;

// ---- Optional: smoke test ----------------------------------------------
// Run `node examples/custom-skill/random-quote.mjs` to verify the
// contract holds (single-key { output } shape, non-empty string).
if (import.meta.url === `file://${process.argv[1]}`) {
  const skill = createRandomQuoteSkill();
  const r = await skill.execute('hello');
  if (typeof r.output !== 'string' || r.output.length === 0) {
    console.error('FAIL: execute() did not return { output: string }');
    process.exit(1);
  }
  if (Object.keys(r).sort().join(',') !== 'output') {
    console.error('FAIL: shape is not single-key { output }; got keys: ' + Object.keys(r).join(','));
    process.exit(1);
  }
  console.log('OK:', r.output);
}