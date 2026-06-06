/**
 * IProvider: LLM provider contract (data interface).
 *
 * Concrete providers are plain {name, capabilities, chat, ...} objects.
 * They are validated via IProvider.validate (duck typing) at registry time.
 *
 * v2 design (PR 6, skeleton only): protocol/impl come in PR 7+ via
 * self-evolution. IProvider is just the shape.
 *
 * Implementation note: IProvider is a plain object (not a class) because
 * classes have read-only `name`/`length` that we can't override cleanly.
 */

export const IProvider = {
  name: '', // sentinel: real provider must set its own name
  capabilities: ['chat'],
  prototype: {
    async chat(_m, _o) {
      throw new Error('[IProvider] chat() not implemented');
    },
    async stream(_m, _o) {
      throw new Error('[IProvider] stream() not implemented');
    },
    async embed(_t) {
      throw new Error('[IProvider] embed() not implemented');
    },
    async listModels() {
      return [];
    },
  },
  validate(provider) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('[IProvider] validate: provider must be object');
    }
    if (typeof provider.name !== 'string' || provider.name.length === 0) {
      throw new TypeError('[IProvider] validate: provider.name must be non-empty string');
    }
    if (!Array.isArray(provider.capabilities)) {
      throw new TypeError(
        `[IProvider] validate: provider.capabilities must be array (got ${typeof provider.capabilities})`,
      );
    }
    for (const cap of provider.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[IProvider] validate: each capability must be string');
      }
    }
    if (typeof provider.chat !== 'function') {
      throw new TypeError('[IProvider] validate: provider.chat must be function');
    }
    return { ok: true };
  },
};
