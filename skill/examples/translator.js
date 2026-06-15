/**
 * translator — Darwin skill: translate text between languages.
 *
 * Stub implementation: prefixes input with `[translated to <target>]`.
 * Real LLM call lives behind a TODO(p2) seam — `wireToLLM()` placeholder
 * shows where a provider.chat() call goes once SelfEvolution wires providers.
 *
 * Supports `target` parameter (e.g. 'en', 'zh', 'ja'); defaults to 'en'.
 *
 * LLM gate (ADR-009): PR-S1 stub does NOT call LLM.
 */

export const translator = {
  name: 'translator',
  description: 'Translate text between languages (v3+ P1 catalog item).',
  triggers: ['translate', 'translation', '翻译'],
  systemPromptHint:
    'User wants a translation. Preserve tone; detect source language; ask if ambiguous.',
  async execute(input, context = {}) {
    const text = typeof input === 'string' ? input : String(input);
    // Support options via context.options or as 2nd-arg object form.
    const opts = context?.options && typeof context.options === 'object' ? context.options : {};
    const target = (opts.target || context?.target || 'en').toString();
    // TODO(p2): wire to provider.chat() — replace the prefix with a real LLM call.
    // e.g.  const llm = container.get('provider').get('deepseek');
    //       const { text: out } = await llm.chat({
    //         prompt: `Translate to ${target}:\n${text}`,
    //       });
    return { output: `[translated to ${target}] ${text}` };
  },
};

export default translator;
