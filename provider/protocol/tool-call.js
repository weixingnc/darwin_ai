/**
 * Tool-call protocol layer — v1 飞书 bug fix core.
 *
 * Implements the OpenAI / MiniMax wire format for tool calls in chat.
 * v0.25 飞书 bug: tool_calls 格式错 + 无 tool_call_id 回传 + 无 MAX_TOOL_ROUNDS
 * + 工具异常无 try/catch + 无 finish_reason / stop_reason 日志. v2 fixes all 6.
 *
 * Functions:
 *  - formatToolCalls(toolCalls, results): returns 1 assistant + N role:tool messages
 *  - parseAssistantToolCalls(assistantMessage): extracts toolCalls (never throws)
 *  - buildToolResultMessage(toolCall, result): single role:tool message
 *  - MAX_TOOL_ROUNDS: hard limit (5, per ANTI-PATTERNS D-2)
 *  - ToolCallProtocol class: utility for finish_reason / stop_reason logging
 *
 * All parsing/formatting funcs NEVER throw — malformed input yields safe defaults
 * (empty arrays / empty content). This is the v1 D-3 fix: a single bad tool
 * message must not break the round.
 *
 * Wire format (OpenAI / MiniMax):
 *   { role: 'assistant', tool_calls: [...] }       ← one message
 *   { role: 'tool', tool_call_id: '...', content }  ← N messages, one per result
 *
 * v1 ANTI-PATTERN: pushing { role: 'assistant', tool_calls: [tc] } per toolCall
 * broke Round 2 because the LLM never saw all toolCalls in one assistant turn.
 */

/** Maximum tool-call rounds per chat (hard cap, ANTI-PATTERNS D-2). */
export const MAX_TOOL_ROUNDS = 5;

/**
 * Format an assistant tool-call turn as messages.
 * @param {Array<{id:string,name:string,arguments:string|object}>} toolCalls
 * @param {Array<string|object>} results - one result per toolCall
 * @returns {Array<{role:string,tool_calls?:Array,tool_call_id?:string,content:string}>}
 * @throws {RangeError} when toolCalls.length > MAX_TOOL_ROUNDS
 */
export function formatToolCalls(toolCalls, results) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }
  if (toolCalls.length > MAX_TOOL_ROUNDS) {
    throw new RangeError(
      `[tool-call] formatToolCalls: ${toolCalls.length} > MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS})`,
    );
  }
  const safeResults = Array.isArray(results) ? results : [];
  const messages = [];
  // ONE assistant message with ALL toolCalls — v1 飞书 bug fix #1
  messages.push({ role: 'assistant', tool_calls: toolCalls.slice() });
  // N role:tool messages, one per result, in order
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    messages.push(buildToolResultMessage(tc, safeResults[i]));
  }
  return messages;
}

/**
 * Parse toolCalls out of an assistant message. NEVER throws.
 * @param {object|null|undefined} msg
 * @returns {Array<object>} toolCalls (empty if absent/malformed)
 */
export function parseAssistantToolCalls(msg) {
  try {
    if (!msg || typeof msg !== 'object') {
      return [];
    }
    if (msg.role !== 'assistant') {
      return [];
    }
    if (!Array.isArray(msg.tool_calls)) {
      return [];
    }
    return msg.tool_calls.filter((tc) => tc && typeof tc === 'object' && typeof tc.id === 'string');
  } catch {
    return [];
  }
}

/**
 * Build a single role:tool result message. tool_call_id is required.
 * @param {{id:string}} toolCall
 * @param {string|object|null|undefined} result
 * @returns {{role:'tool',tool_call_id:string,content:string}}
 */
export function buildToolResultMessage(toolCall, result) {
  const id = toolCall && typeof toolCall.id === 'string' ? toolCall.id : '';
  let content;
  if (typeof result === 'string') {
    content = result;
  } else if (result === null || result === undefined) {
    content = '';
  } else {
    // Serialize objects (incl. nested cause) as JSON so the LLM sees a string.
    try {
      content = JSON.stringify(result);
    } catch {
      content = String(result);
    }
  }
  return { role: 'tool', tool_call_id: id, content };
}

/**
 * ToolCallProtocol: utility class for finish_reason / stop_reason logging.
 * v1 飞书 bug fix #5 & #6: emit a log line on every finish/stop so the round
 * is debuggable. Does NOT throw.
 */
export class ToolCallProtocol {
  /** Log OpenAI-style finish_reason. */
  logFinishReason(reason, extra) {
    try {
      const r = reason === null || reason === undefined ? 'unknown' : String(reason);
      const tag = extra && extra.anthropic ? 'stop_reason' : 'finish_reason';
      console.log(`[tool-call] ${tag}=${r}`);
    } catch {
      // never throw
    }
  }

  /** Log Anthropic-style stop_reason. */
  logStopReason(reason, extra) {
    try {
      const r = reason === null || reason === undefined ? 'unknown' : String(reason);
      const tag = extra && extra.openai ? 'finish_reason' : 'stop_reason';
      console.log(`[tool-call] ${tag}=${r}`);
    } catch {
      // never throw
    }
  }
}
