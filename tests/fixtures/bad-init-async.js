// Test fixture: plugin whose init() throws asynchronously.
export default {
  name: 'bad-init-async',
  version: '1.0.0',
  capabilities: ['tool'],
  async init() {
    throw new Error('aboom');
  },
  destroy() {},
  enable() {},
  disable() {},
};
