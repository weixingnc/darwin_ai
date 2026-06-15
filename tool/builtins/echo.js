/**
 * Echo — the simplest possible Darwin built-in tool.
 *
 * Used as the P1 self-evolution demo's first piece of "肉" (meat):
 *   darwin self-evolution apply <echo-proposal>
 * will add this file (under whitelist `tool/builtins/*`, ADR-005) so the
 * e2e test can prove Darwin's full apply → verify → rollback loop works
 * end-to-end.
 *
 * Contract:
 *   - name: 'echo' (stable string — Darwin tool registry looks it up by name)
 *   - description: human-readable (Darwin uses it for systemHint wiring)
 *   - schema: JSON-Schema-ish (input validation lives at the tool-caller)
 *   - execute({ input: string }) → { output: string }
 *
 * LLM gate (ADR-009): echo is mechanical, no LLM.
 */

export const echo = {
  name: 'echo',
  description: 'Echo input verbatim (simplest tool for self-evolution demo)',
  schema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'string to echo back' },
    },
    required: ['input'],
  },
  async execute({ input } = {}) {
    if (typeof input !== 'string') {
      throw new TypeError('echo.execute: input must be a string');
    }
    return { output: input };
  },
};

export default echo;
