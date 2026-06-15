/**
 * summarizer — Darwin skill: condense long text into a short summary.
 *
 * Stub implementation: returns first 200 chars (v3+ P1 catalog validation).
 * Real LLM call lives behind a TODO(p2) seam — `wireToLLM()` placeholder
 * shows where a provider.chat() call goes once SelfEvolution wires providers.
 *
 * Skill contract: see hello-world.js.
 *
 * LLM gate (ADR-009): PR-S1 stub does NOT call LLM. The stub returns a
 * deterministic slice so callers can verify trigger + output shape without
 * network. P2 will replace `execute()` body with a provider.chat() call.
 */

export const summarizer = {
  name: 'summarizer',
  description: 'Condense long text into a short summary (v3+ P1 catalog item).',
  triggers: ['summarize', 'summary', 'tldr'],
  systemPromptHint: 'User wants a summary. Be concise; preserve key facts; ignore boilerplate.',
  async execute(input /* , context */) {
    const text = typeof input === 'string' ? input : String(input);
    // TODO(p2): wire to provider.chat() — replace the slice below with a real
    // LLM call once `provider/deepseek.js` + `provider/qwen.js` are wired in.
    // e.g.  const llm = container.get('provider').get('deepseek');
    //       const { text } = await llm.chat({ prompt: `Summarize:\n${text}` });
    const summary = text.length <= 200 ? text : `${text.slice(0, 200)}…`;
    return { output: summary };
  },
};

export default summarizer;
