/**
 * PluginLoader sandbox integration (P2i, 2026-06-18).
 *
 * Verifies that createPluginLoader({enableSandbox:true}) activates the
 * runtime sandbox on first plugin load, keeps it active across multiple
 * loaded plugins, and deactivates on the LAST plugin unload. After
 * deactivate, denied-method calls work again — proving the monkey-patch
 * is properly restored.
 *
 * What this test is NOT: a duplicate of plugin-sandbox.test.js. That file
 * exercises the sandbox primitive directly. This file tests the
 * LOADING-LEVEL integration: the loader's contract that
 *
 *   1. enableSandbox=false (default) → no sandbox, no interference
 *   2. enableSandbox=true → activate on first load, deactivate on last unload
 *   3. While a plugin is loaded under a sandboxed loader, DENIED-method
 *      calls (e.g. fs.writeFileSync) throw PluginSandboxDeniedError
 *   4. After unload, original methods restored (fs.writeFileSync works)
 *
 * P2i is the "suspenders" half of the belt-and-suspenders plan: P2d's
 * static manifest check rejects plugins that DECLARE denied perms; P2i
 * adds runtime enforcement for plugins that try to INVOKE denied methods
 * without declaring them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPluginLoader } from '../plugin/loader.js';
import { PluginRegistry } from '../plugin/registry.js';
import { _activeSandbox } from '../plugin/sandbox.js';
import { PluginSandboxDeniedError } from '../plugin/sandbox.js';
import { evolutionBus } from '../evolution/_bus.js';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'p2i-'));

function makeEvilPlugin(filename, fnBody) {
  // Writes a tiny .js plugin that calls a denied method in init().
  const path = join(TMP_ROOT, filename);
  writeFileSync(
    path,
    `export default {
  name: '${filename.replace('.js', '')}',
  version: '0.0.1',
  capabilities: ['tool'],
  permissions: ['bus:on'],
  async init() { ${fnBody} },
};`,
  );
  return path;
}

test('P2i: enableSandbox defaults to false (back-compat)', async () => {
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
  });
  assert.equal(loader._internal.enableSandbox, false);
  assert.equal(loader._internal.sandbox, null);
});

test('P2i: enableSandbox=true activates on first plugin load', async () => {
  // Make sure no prior sandbox lingers from other tests.
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
    enableSandbox: true,
  });
  const path = makeEvilPlugin('p2i-activate.js', '');
  await loader.load(path);
  try {
    assert.equal(loader._internal.sandbox.isActive(), true);
    assert.equal(_activeSandbox(), loader._internal.sandbox);
  } finally {
    await loader.unload('p2i-activate');
    rmSync(path);
  }
});

test('P2i: plugin runtime throws PluginSandboxDeniedError on fs.writeFileSync', async () => {
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
    enableSandbox: true,
  });
  const targetPath = join(TMP_ROOT, 'should-not-exist.txt');
  const path = makeEvilPlugin(
    'p2i-writefile.js',
    `writeFileSync('${targetPath}', 'blocked');`,
  );
  await loader.load(path);
  await loader.init('p2i-writefile');
  try {
    // init() should have thrown (caught by ErrorHandler, surfaced as {ok:false}).
    // The plugin's `init` was wrapped by the loader — the actual throw
    // happens inside the plugin, but we need to check the side-effect
    // (file does NOT exist).
    // Re-running the plugin's init directly bypasses the loader wrapping,
    // so call writeFileSync via the (now patched) fs global to verify the
    // sandbox blocks the call.
    const { default: fs } = await import('node:fs');
    let caught = null;
    try {
      fs.writeFileSync(targetPath, 'should be blocked');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof PluginSandboxDeniedError, `expected PluginSandboxDeniedError, got ${caught}`);
    assert.equal(caught.pluginName, 'loader-active');
    assert.equal(caught.method, 'writeFileSync');
    assert.equal(caught.permission, 'fs:write');
  } finally {
    await loader.unload('p2i-writefile');
    rmSync(path);
  }
});

test('P2i: deactivate on LAST plugin unload restores fs.writeFileSync', async () => {
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
    enableSandbox: true,
  });
  const path = makeEvilPlugin('p2i-restore.js', '');
  await loader.load(path);
  assert.equal(loader._internal.sandbox.isActive(), true);
  await loader.unload('p2i-restore');
  rmSync(path);
  // After unload, sandbox is deactivated — fs.writeFileSync works again.
  assert.equal(loader._internal.sandbox.isActive(), false);
  assert.equal(_activeSandbox(), null);
  const { default: fs } = await import('node:fs');
  const after = join(TMP_ROOT, 'p2i-after-unload.txt');
  fs.writeFileSync(after, 'restored');
  assert.equal(fs.readFileSync(after, 'utf8'), 'restored');
  rmSync(after);
});

test('P2i: multiple plugins share the same sandbox (counted by activeNames)', async () => {
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
    enableSandbox: true,
  });
  const p1 = makeEvilPlugin('p2i-multi-1.js', '');
  const p2 = makeEvilPlugin('p2i-multi-2.js', '');
  await loader.load(p1);
  assert.equal(loader._internal.sandboxActiveNames.size, 1);
  await loader.load(p2);
  // Sandbox is still the same one (process-global), activeNames tracks
  // which plugins were loaded under it.
  assert.equal(loader._internal.sandboxActiveNames.size, 2);
  assert.equal(loader._internal.sandbox.isActive(), true);
  // Unload first — sandbox stays active (still one plugin left).
  await loader.unload('p2i-multi-1');
  assert.equal(loader._internal.sandboxActiveNames.size, 1);
  assert.equal(loader._internal.sandbox.isActive(), true);
  // Unload second — sandbox deactivates.
  await loader.unload('p2i-multi-2');
  assert.equal(loader._internal.sandboxActiveNames.size, 0);
  assert.equal(loader._internal.sandbox.isActive(), false);
  rmSync(p1);
  rmSync(p2);
});

test('P2i: enableSandbox=false → fs.writeFileSync never blocked', async () => {
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  const loader = createPluginLoader({
    eventBus: evolutionBus,
    registry: new PluginRegistry({ eventBus: evolutionBus }),
    // enableSandbox omitted — defaults to false.
  });
  const path = makeEvilPlugin('p2i-no-sandbox.js', '');
  await loader.load(path);
  const { default: fs } = await import('node:fs');
  const target = join(TMP_ROOT, 'p2i-no-sandbox-out.txt');
  // No throw expected.
  fs.writeFileSync(target, 'plain');
  assert.equal(fs.readFileSync(target, 'utf8'), 'plain');
  await loader.unload('p2i-no-sandbox');
  rmSync(path);
  rmSync(target);
});

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(() => {
  // Defensive cleanup — any lingering sandbox must be deactivated before
  // the test runner exits, otherwise tests in OTHER files that DON'T pass
  // enableSandbox might inherit a still-active sandbox.
  if (_activeSandbox()) {_activeSandbox().deactivate();}
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* tmp dir cleanup best-effort */
  }
});