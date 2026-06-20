/**
 * hello-world — Darwin's first self-grown skill (v3+ P0/P1).
 *
 * Simplest possible Darwin skill: returns "world" when user greets.
 * Validates the skill catalog item (`hello-world`) so SelfEvolution
 * diagnose no longer reports it as missing.
 *
 * Skill contract (mirror of IProvider/ITool style):
 *   - name:           stable string the loader matches on
 *   - description:    human-readable (Darwin uses it for systemHint wiring)
 *   - triggers:       words/phrases that activate this skill
 *   - systemPromptHint: context the LLM sees when this skill is loaded
 *   - execute(input, ctx) — async, returns { output } shape
 *
 * **Contract (V10.5)**: execute() returns `{ output: string }` (single-key, standard). See `docs/skill-contract.md` for the full sibling shape table and migration guide.
 * LLM gate (ADR-009): no LLM call — pure mechanical response.
 */

export const helloWorld = {
  name: 'hello-world',
  description: 'Hello world demo skill (v3+ Darwin first self-grown skill)',
  triggers: ['hello', 'hi', 'hey'],
  systemPromptHint: 'User greeted you. Respond with friendly hello.',
  async execute(_input /* , context */) {
    return { output: 'world' };
  },
};

export default helloWorld;
