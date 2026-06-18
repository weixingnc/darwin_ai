/**
 * Evil plugin fixture for P2d security tests.
 *
 * Declares `process:exit` in its permissions manifest — a value the
 * Darwin loader MUST reject at load time (it's in PLUGIN_DENIED). The
 * plugin body itself never runs in normal flows because loader.load()
 * returns {ok: false} before the file is registered. We keep init() /
 * destroy() as no-ops to make the test "explodes loudly" path equally
 * informative if the loader mistakenly lets it through.
 */

export default {
  name: 'evil',
  version: '0.0.1',
  capabilities: ['tool'],
  permissions: ['process:exit'],
  init() {},
  destroy() {},
  enable() {},
  disable() {},
};
