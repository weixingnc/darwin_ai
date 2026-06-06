/**
 * IProtocol: wire-format protocol contract.
 *
 * Independent of IProvider — protocol layer does not know about provider
 * classes. Concrete protocols (openai-compatible, anthropic) are plain
 * objects validated via IProtocol.validate at registration time.
 *
 * v2 design (PR 7, skeleton only): concrete protocols come in PR 8+ via
 * self-evolution. IProtocol is just the shape.
 *
 * v1 lesson: tool-call format was hard-coded inside provider; v2 isolates
 * it behind a protocol interface + a dedicated tool-call layer.
 *
 * Implementation note: IProtocol is a plain object (not a class) — same
 * reason as IProvider (classes have read-only name/length).
 */

export const IProtocol = {
  name: '', // sentinel: real protocol must set its own name
  buildRequest(_messages, _options, _model) {
    throw new Error('[IProtocol] buildRequest() not implemented');
  },
  parseResponse(_rawResponse) {
    throw new Error('[IProtocol] parseResponse() not implemented');
  },
  parseStreamChunk(_chunk) {
    throw new Error('[IProtocol] parseStreamChunk() not implemented');
  },
  buildToolCallMessage(_toolCall, _result) {
    throw new Error('[IProtocol] buildToolCallMessage() not implemented');
  },
  parseToolCallDelta(_delta) {
    throw new Error('[IProtocol] parseToolCallDelta() not implemented');
  },
  validate(protocol) {
    if (!protocol || typeof protocol !== 'object') {
      throw new TypeError('[IProtocol] validate: protocol must be object');
    }
    if (typeof protocol.name !== 'string' || protocol.name.length === 0) {
      throw new TypeError('[IProtocol] validate: protocol.name must be non-empty string');
    }
    const required = [
      'buildRequest',
      'parseResponse',
      'parseStreamChunk',
      'buildToolCallMessage',
      'parseToolCallDelta',
    ];
    for (const m of required) {
      if (typeof protocol[m] !== 'function') {
        throw new TypeError(`[IProtocol] validate: protocol.${m} must be function`);
      }
    }
    return { ok: true };
  },
};
