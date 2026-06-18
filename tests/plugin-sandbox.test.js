/**
 * Plugin sandbox tests — P2e (2026-06-18).
 *
 * P2e adds the runtime half of plugin safety. P2d's static manifest check
 * (PLUGIN_DENIED ∩ permissions === ∅) stops a plugin from *declaring*
 * a denied permission. P2e's runtime sandbox stops a plugin from
 * *invoking* a denied method even when it bypasses the manifest
 * (e.g. by reaching into process / fs / child_process directly).
 *
 * Tests cover the full target list from SANDBOX_TARGETS:
 *   - process.exit (process:exit)
 *   - fs.rmSync, fs.unlinkSync, fs.promises.rm (fs:delete)
 *   - fs.writeFileSync, fs.promises.writeFile (fs:write)
 *   - child_process.execSync, child_process.exec,
 *     child_process.spawnSync, child_process.spawn (child_process:exec)
 *
 * network:raw is intentionally NOT covered — P2e doesn't sandbox it
 * (the static check already blocks the declaration; monkey-patching
 * fetch / net is brittle and not worth the test surface for v2).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';

import { createSandbox, PluginSandboxDeniedError, _activeSandbox } from '../plugin/sandbox.js';

function sentinelKey(method) {
  return `${method}__darwinSandboxPatched`;
}

describe('plugin sandbox — activation lifecycle', () => {
  let sandbox;

  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
      sandbox = null;
    }
    assert.equal(_activeSandbox(), null, 'no leaked sandbox after each test');
  });

  test('isActive() reflects state correctly', () => {
    sandbox = createSandbox({ pluginName: 'test' });
    assert.equal(sandbox.isActive(), false);
    sandbox.activate();
    assert.equal(sandbox.isActive(), true);
    sandbox.deactivate();
    assert.equal(sandbox.isActive(), false);
  });

  test('activate() is idempotent (calling twice does not double-patch)', () => {
    sandbox = createSandbox({ pluginName: 'test' });
    sandbox.activate();
    const firstPatches = sandbox._patches().length;
    sandbox.activate();
    assert.equal(
      sandbox._patches().length,
      firstPatches,
      'activate() twice should not add new patches',
    );
  });

  test('deactivate() is idempotent (calling twice does not throw)', () => {
    sandbox = createSandbox({ pluginName: 'test' });
    sandbox.activate();
    sandbox.deactivate();
    sandbox.deactivate(); // should not throw
    assert.equal(sandbox.isActive(), false);
  });

  test('cannot activate a second sandbox while one is active', () => {
    sandbox = createSandbox({ pluginName: 'first' });
    sandbox.activate();
    const other = createSandbox({ pluginName: 'second' });
    assert.throws(() => other.activate(), /sandbox for "first" is already active/);
    // Cleanup: deactivate the original.
    sandbox.deactivate();
  });
});

describe('plugin sandbox — process:exit blocks', () => {
  let sandbox;
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
  });

  test('process.exit throws PluginSandboxDeniedError while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => process.exit(0),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.pluginName, 'evil');
        assert.equal(err.method, 'exit');
        assert.equal(err.permission, 'process:exit');
        return true;
      },
    );
  });

  test('process.exit works again after deactivate()', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    sandbox.deactivate();
    // After deactivate, calling process.exit would actually exit the
    // test process. So instead just verify the original is back by
    // checking the SENTINEL key is gone and process.exit is still a
    // function. (Calling exit here would kill the test runner.)
    assert.equal(typeof process.exit, 'function');
    assert.equal(process[sentinelKey('exit')], undefined);
  });
});

describe('plugin sandbox — fs:delete blocks', () => {
  let sandbox;
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fs-'));
  });
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup
    }
  });

  test('fs.rmSync throws while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => fs.rmSync(tmpDir, { recursive: true, force: true }),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'rmSync');
        assert.equal(err.permission, 'fs:delete');
        return true;
      },
    );
  });

  test('fs.unlinkSync throws while active', () => {
    const target = path.join(tmpDir, 'file');
    fs.writeFileSync(target, 'x');
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => fs.unlinkSync(target),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'unlinkSync');
        return true;
      },
    );
  });

  test('fs.promises.rm rejects while active', async () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    await assert.rejects(
      async () => fs.promises.rm(tmpDir, { recursive: true, force: true }),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'rm');
        return true;
      },
    );
  });

  test('fs.rmSync works after deactivate()', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    sandbox.deactivate();
    // Original is back — rmSync should work normally (not throw).
    assert.doesNotThrow(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    assert.equal(fs.existsSync(tmpDir), false);
  });
});

describe('plugin sandbox — fs:write blocks', () => {
  let sandbox;
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fs-w-'));
  });
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup
    }
  });

  test('fs.writeFileSync throws while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => fs.writeFileSync(path.join(tmpDir, 'x'), 'tampered'),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'writeFileSync');
        assert.equal(err.permission, 'fs:write');
        return true;
      },
    );
  });

  test('fs.promises.writeFile rejects while active', async () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    await assert.rejects(
      async () => fs.promises.writeFile(path.join(tmpDir, 'x'), 'tampered'),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'writeFile');
        return true;
      },
    );
  });
});

describe('plugin sandbox — child_process:exec blocks', () => {
  let sandbox;
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
  });

  test('child_process.execSync throws while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => childProcess.execSync('echo hi'),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'execSync');
        assert.equal(err.permission, 'child_process:exec');
        return true;
      },
    );
  });

  test('child_process.exec (async) callback receives an Error while active', async () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    // Patched exec throws synchronously. Wrap the call so the sync
    // throw becomes a Promise resolution instead of an unhandled
    // exception inside the Promise executor.
    const result = await new Promise((resolve) => {
      try {
        childProcess.exec('echo hi', (cbErr) => resolve({ cbErr }));
      } catch (syncErr) {
        resolve({ syncErr });
      }
    });
    if (result.syncErr) {
      assert.ok(result.syncErr instanceof PluginSandboxDeniedError);
      assert.equal(result.syncErr.method, 'exec');
    } else if (result.cbErr) {
      assert.ok(result.cbErr instanceof PluginSandboxDeniedError);
      assert.equal(result.cbErr.method, 'exec');
    } else {
      assert.fail(
        'exec returned without error AND without invoking the callback — sandbox did not block the call',
      );
    }
  });

  test('child_process.spawnSync throws while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => childProcess.spawnSync('echo', ['hi']),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'spawnSync');
        return true;
      },
    );
  });

  test('child_process.spawn throws while active', () => {
    sandbox = createSandbox({ pluginName: 'evil' });
    sandbox.activate();
    assert.throws(
      () => childProcess.spawn('echo', ['hi']),
      (err) => {
        assert.ok(err instanceof PluginSandboxDeniedError);
        assert.equal(err.method, 'spawn');
        return true;
      },
    );
  });
});

describe('plugin sandbox — allowlist mode', () => {
  let sandbox;
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
  });

  test('deny:[] means the sandbox installs no patches', () => {
    sandbox = createSandbox({ pluginName: 'safe', deny: [] });
    sandbox.activate();
    assert.equal(sandbox._patches().length, 0);
    // process.exit should NOT throw because no patch is installed.
    // We can't actually call exit (would kill the runner), so we just
    // assert that process.exit is still the original function (no
    // SENTINEL key on process).
    assert.equal(process[sentinelKey('exit')], undefined);
  });

  test('partial deny: ["fs:delete"] only blocks fs:delete methods', () => {
    sandbox = createSandbox({ pluginName: 'partial', deny: ['fs:delete'] });
    sandbox.activate();
    assert.throws(
      () => fs.rmSync('/tmp', { recursive: true }),
      (err) => err instanceof PluginSandboxDeniedError,
    );
    // fs.writeFileSync is NOT in the partial deny list, so it should
    // NOT throw (writing to /tmp/sandbox-partial-allow-test).
    const probe = path.join(os.tmpdir(), 'sandbox-partial-allow-test');
    assert.doesNotThrow(() => fs.writeFileSync(probe, 'ok'));
    try {
      fs.unlinkSync(probe);
    } catch (_) {
      // best-effort cleanup
    }
  });
});

describe('plugin sandbox — end-to-end simulation', () => {
  let sandbox;
  afterEach(() => {
    if (sandbox) {
      sandbox.deactivate();
    }
  });

  test('a malicious plugin loaded into an activated sandbox cannot escape', () => {
    // Simulate the bad behavior: a plugin tries to rmSync / writeFileSync
    // and exit. With sandbox active, all three must throw.
    sandbox = createSandbox({ pluginName: 'malware' });
    sandbox.activate();

    const attacks = [
      () => process.exit(0),
      () => fs.rmSync('/tmp', { recursive: true, force: true }),
      () => fs.writeFileSync('/tmp/pwned', 'hacked'),
      () => childProcess.execSync('rm -rf /'),
    ];

    for (const attack of attacks) {
      assert.throws(
        attack,
        (err) => err instanceof PluginSandboxDeniedError,
        'attack should be blocked by sandbox',
      );
    }
  });
});
