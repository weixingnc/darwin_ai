/**
 * OpenAI provider — v3+ P1 (Darwin 第一次自我长肉, openai native protocol)
 *
 * v2 已落 openai-compatible（DeepSeek/Qwen 复用），本文件 = openai 原生协议
 * （gpt-4o/o1 系列 + native tools 格式）。Darwin 提议 30 行，本文件 = stub。
 *
 * A-3 lesson: 复用 protocol/openai-compatible（避免双 impl = v1 飞书 bug root cause）
 * A-4 lesson: ConfigResolver.get('provider-openai')，never process.env reads.
 * LLM gate (ADR-009): chat() invokes LLM. Mechanical code only otherwise.
 */

import { ProviderBase } from './base.js';
import { createOpenAICompatibleProtocol } from './protocol/openai-compatible.js';
import { ConfigResolver } from '../core/config-resolver.js';

const NOT_IMPLEMENTED_MSG = '[openai] NOT_IMPLEMENTED';
const DEFAULT_TIMEOUT_MS = 60000;
const STATIC_MODELS = Object.freeze(['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini']);

export class OpenAIProvider extends ProviderBase {
  constructor(eventBus, config) {
    super(eventBus, { name: 'openai', capabilities: ['chat', 'tool-call'] });
    const cfg = ConfigResolver.get('provider-openai', config) || {};
    this.baseUrl = (cfg.baseUrl || 'https://api.openai.com')
      .replace(/\/v1$/, '')
      .replace(/\/+$/, '');
    this.apiKey = cfg.apiKey || '';
    this.protocol = createOpenAICompatibleProtocol(eventBus, { kind: 'openai' });
  }
  async chat(messages, options = {}) {
    return this._wrap('chat', { messages, options }, async (traceId) => {
      const req = this.protocol.buildRequest(
        { model: options.model || 'gpt-4o', messages, ...options },
        traceId,
      );
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(req.payload),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      return this.protocol.parseResponse(await res.json(), traceId);
    });
  }
  listModels() {
    return { ok: true, value: [...STATIC_MODELS] };
  }
  embed() {
    return { ok: false, error: NOT_IMPLEMENTED_MSG };
  }
}

export const createOpenAIProvider = (eventBus, config) => new OpenAIProvider(eventBus, config);
export default createOpenAIProvider;
