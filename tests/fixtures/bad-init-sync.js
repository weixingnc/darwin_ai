// Test fixture: plugin whose init() throws synchronously.
export default {
  name: 'bad-init-sync',
  version: '1.0.0',
  capabilities: ['tool'],
  init() {
    throw new Error('boom');
  },
  destroy() {},
  enable() {},
  disable() {},
};
