/**
 * tests/bin/web.test.js -- V29-actual: `darwin web` subcommand.
 *
 * Strategy: spawn `node bin/darwin web` and verify CLI-level behaviour:
 *   - --help prints HELP and exits 0
 *   - unknown flag exits 1 with a clear error
 *   - --port (no value) exits 1
 *   - --port <invalid> exits 1
 *   - --host (no value) exits 1
 *   - --port <valid> + --host <valid> actually starts the server,
 *     binds to that port, and serves /api/health (then we kill it).
 *
 * We do NOT re-test the http layer (web/server.test.js does that).
 * This file is "is the wrapper wired up correctly".
 *
 * v2 hygiene: no real api_key, no real network. The /api/health
 * call is over loopback only.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DARWIN_BIN = join(REPO_ROOT, 'bin', 'darwin');

function runSync(args, env = {}) {
  return spawnSync('node', [DARWIN_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

const longLived = [];
function spawnLongLived(args, env = {}) {
  const child = spawn('node', [DARWIN_BIN, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  longLived.push(child);
  return child;
}

after(() => {
  for (const c of longLived) {
    if (!c.killed) {
      try {
        c.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
  }
});

// Poll /api/health until 200 or until the timeout elapses.
function waitForHealth(port, host, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const req = request(
        { host, port, path: '/api/health', method: 'GET', timeout: 500 },
        (res) => {
          // Drain and resolve.
          res.resume();
          if (res.statusCode === 200) {
            resolveWait();
          } else {
            retry();
          }
        },
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
      req.end();
    };
    const retry = () => {
      if (Date.now() > deadline) {
        rejectWait(new Error(`server did not become healthy on ${host}:${port} within ${ms}ms`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

describe('darwin web (V29-actual)', () => {
  test('hygiene: no real api_key in wrapper source (Darwin A-4)', () => {
    const src = readFileSync(join(REPO_ROOT, 'bin', 'lib', 'web.js'), 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), 'bin/lib/web.js must not contain real sk-... key');
  });

  test('darwin web --help exits 0 and shows the subcommand help', () => {
    const r = runSync(['web', '--help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin web'), `stdout should mention "darwin web"`);
    assert.ok(r.stdout.includes('--port'), `stdout should mention --port flag`);
    assert.ok(r.stdout.includes('--host'), `stdout should mention --host flag`);
  });

  test('darwin web --port not-a-port exits 1', () => {
    const r = runSync(['web', '--port', 'not-a-port']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('invalid --port'),
      `stderr should mention 'invalid --port', was: ${r.stderr}`,
    );
  });

  test('darwin web --port (no value) exits 1', () => {
    const r = runSync(['web', '--port']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('--port requires a value'),
      `stderr should mention '--port requires a value', was: ${r.stderr}`,
    );
  });

  test('darwin web --port 99999 (out of range) exits 1', () => {
    const r = runSync(['web', '--port', '99999']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('invalid --port'),
      `stderr should mention 'invalid --port', was: ${r.stderr}`,
    );
  });

  test('darwin web --port 0 (out of range) exits 1', () => {
    const r = runSync(['web', '--port', '0']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('invalid --port'), `stderr: ${r.stderr}`);
  });

  test('darwin web --host (no value) exits 1', () => {
    const r = runSync(['web', '--host']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('--host requires a value'),
      `stderr should mention '--host requires a value', was: ${r.stderr}`,
    );
  });

  test('darwin web --unknown-flag exits 1', () => {
    const r = runSync(['web', '--definitely-not-a-real-flag']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('unknown flag'),
      `stderr should mention 'unknown flag', was: ${r.stderr}`,
    );
  });

  test('darwin web --port 18760 --host 127.0.0.1 actually starts the server', async () => {
    // Use a non-default high port to avoid colliding with a dev server.
    // The /api/health endpoint is used as a readiness probe.
    const child = spawnLongLived(['web', '--port', '18760', '--host', '127.0.0.1']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    try {
      await waitForHealth(18760, '127.0.0.1', 5000);
      assert.ok(true, 'server became healthy on 127.0.0.1:18760');
    } catch (e) {
      assert.fail(`server did not start: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`);
    } finally {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
  });
});

describe('darwin web stop / status (V30)', () => {
  // Use a unique fake pidfile path during these tests so we don't trample
  // on a real running server. We do this by setting the HOME env var to
  // a tmpdir; web-pidfile.js uses homedir() + .darwin/web.pid.
  test('darwin web status (no pidfile) exits 0 and reports "not running"', () => {
    const r = runSync(['web', 'status'], { HOME: '/tmp/darwin-empty-home-' + Date.now() });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('no server is running'),
      `stdout should mention 'no server is running', was: ${r.stdout}`,
    );
  });

  test('darwin web stop (no pidfile) exits 0 and reports "not running"', () => {
    const r = runSync(['web', 'stop'], { HOME: '/tmp/darwin-empty-home-' + Date.now() });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('no server is running'),
      `stdout should mention 'no server is running', was: ${r.stdout}`,
    );
  });

  test('darwin web status --help exits 0 and shows subcommand help', () => {
    const r = runSync(['web', 'status', '--help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin web status'), `stdout should mention subcommand name`);
  });

  test('darwin web stop --help exits 0 and shows subcommand help', () => {
    const r = runSync(['web', 'stop', '--help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin web stop'), `stdout should mention subcommand name`);
  });

  test('darwin web --help now mentions stop and status (V30)', () => {
    const r = runSync(['web', '--help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin web stop'), `--help should mention stop`);
    assert.ok(r.stdout.includes('darwin web status'), `--help should mention status`);
    assert.ok(r.stdout.includes('--detach'), `--help should mention --detach flag`);
  });

  test('darwin web --detach starts a background server that /api/health responds to', async () => {
    const home = '/tmp/darwin-detach-test-' + Date.now();
    process.env.HOME_FOR_TEST = home; // informational; we set HOME via runSync
    const child = spawnLongLived(['web', '--detach', '--port', '18761', '--host', '127.0.0.1'], {
      HOME: home,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    try {
      // Parent should exit 0 quickly (within ~3s) after writing the pidfile.
      const exitCode = await new Promise((res, rej) => {
        const t = setTimeout(
          () => rej(new Error('darwin web --detach parent did not exit in 3s')),
          3000,
        );
        child.on('exit', (code) => {
          clearTimeout(t);
          res(code);
        });
      });
      assert.equal(
        exitCode,
        0,
        `--detach parent should exit 0, got ${exitCode}
stdout: ${stdout}
stderr: ${stderr}`,
      );
      assert.ok(stdout.includes('detached'), `stdout should mention 'detached', was: ${stdout}`);

      // Wait a bit for the actual web server to listen.
      await new Promise((r2) => setTimeout(r2, 500));
      await waitForHealth(18761, '127.0.0.1', 5000);
      assert.ok(true, 'detached server is healthy on 127.0.0.1:18761');
    } finally {
      // Clean up: stop the detached server and remove the pidfile.
      try {
        spawnSync('node', [DARWIN_BIN, 'web', 'stop'], { env: { ...process.env, HOME: home } });
      } catch (_) {
        /* ignore */
      }
    }
  });

  test('darwin web status (after --detach) reports the running pid', async () => {
    const home = '/tmp/darwin-status-test-' + Date.now();
    const child = spawnLongLived(['web', '--detach', '--port', '18762', '--host', '127.0.0.1'], {
      HOME: home,
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await new Promise((res) => {
        const t = setTimeout(() => res(), 3000);
        child.on('exit', () => {
          clearTimeout(t);
          res();
        });
      });
      // Wait for server to listen.
      await waitForHealth(18762, '127.0.0.1', 5000);

      // Now invoke `darwin web status` against the same HOME.
      const r = runSync(['web', 'status'], { HOME: home });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('running'), `stdout should say 'running', was: ${r.stdout}`);
      assert.ok(r.stdout.includes('18762'), `stdout should mention port 18762, was: ${r.stdout}`);
      assert.ok(r.stdout.includes('uptime'), `stdout should mention 'uptime', was: ${r.stdout}`);
    } finally {
      try {
        spawnSync('node', [DARWIN_BIN, 'web', 'stop'], { env: { ...process.env, HOME: home } });
      } catch (_) {
        /* ignore */
      }
    }
  });

  test('darwin web stop (after --detach) actually kills the server', async () => {
    const home = '/tmp/darwin-stop-test-' + Date.now();
    const child = spawnLongLived(['web', '--detach', '--port', '18763', '--host', '127.0.0.1'], {
      HOME: home,
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await new Promise((res) => {
        const t = setTimeout(() => res(), 3000);
        child.on('exit', () => {
          clearTimeout(t);
          res();
        });
      });
      await waitForHealth(18763, '127.0.0.1', 5000);

      // Now stop it via the CLI.
      const r = runSync(['web', 'stop'], { HOME: home });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('stopped'), `stdout should say 'stopped', was: ${r.stdout}`);

      // Server should be unreachable now.
      await new Promise((res2) => setTimeout(res2, 500));
      const probe = spawnSync(
        'node',
        [
          '-e',
          `require('http').get('http://127.0.0.1:18763/api/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(2))`,
        ],
        { timeout: 3000 },
      );
      assert.notEqual(probe.status, 0, 'server should not respond after stop');
    } finally {
      // Idempotent cleanup.
      try {
        spawnSync('node', [DARWIN_BIN, 'web', 'stop'], { env: { ...process.env, HOME: home } });
      } catch (_) {
        /* ignore */
      }
    }
  });

  test('darwin web --detach (second call) exits 1 with "already running"', async () => {
    const home = '/tmp/darwin-dup-test-' + Date.now();
    const child1 = spawnLongLived(['web', '--detach', '--port', '18764', '--host', '127.0.0.1'], {
      HOME: home,
    });
    child1.stdout.on('data', () => {});
    child1.stderr.on('data', () => {});

    try {
      await new Promise((res) => {
        const t = setTimeout(() => res(), 3000);
        child1.on('exit', () => {
          clearTimeout(t);
          res();
        });
      });
      await waitForHealth(18764, '127.0.0.1', 5000);

      // Second call should fail.
      const r = runSync(['web', '--detach', '--port', '18764', '--host', '127.0.0.1'], {
        HOME: home,
      });
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
      assert.ok(
        r.stderr.includes('already running'),
        `stderr should mention 'already running', was: ${r.stderr}`,
      );
    } finally {
      try {
        spawnSync('node', [DARWIN_BIN, 'web', 'stop'], { env: { ...process.env, HOME: home } });
      } catch (_) {
        /* ignore */
      }
    }
  });
});
