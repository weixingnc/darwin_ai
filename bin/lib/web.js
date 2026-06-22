/**
 * bin/lib/web.js -- V29-actual: `darwin web` subcommand.
 * V30: adds --detach / --no-detach flag for background launching,
 * with pidfile management in bin/lib/web-pidfile.js.
 *
 * Wraps `node web/server.js` so users can launch the local web UI
 * through the standard CLI. Accepts --port, --host, and (V30)
 * --detach flags. Env vars PORT/HOST are fall-through.
 *
 * Why spawn (not import) web/server.js: see V29-actual notes. The
 * detach mode (V30) just switches stdio to 'ignore' + sets
 * `detached: true`, then writes a pidfile at ~/.darwin/web.pid so
 * `darwin web stop` / `status` can find the child later.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  isPidAlive,
  readPidfile,
  writePidfile,
  clearPidfile,
  getPidfilePath,
  formatUptime,
  stopServer,
  describeServer,
} from './web-pidfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_JS = join(REPO_ROOT, 'web', 'server.js');

const HELP = `darwin web -- start the local web UI (V30)

Usage:
  darwin web                            start on default PORT (8080) / HOST (127.0.0.1)
  darwin web --port <N>                 listen on port N (1-65535)
  darwin web --host <H>                 bind to host H (default 127.0.0.1; '0.0.0.0' for all)
  darwin web --detach                   start in background, write pidfile, exit immediately
  darwin web --no-detach                start in foreground (default)
  darwin web stop                       stop the background server (V30)
  darwin web status                     show the background server status (V30)
  darwin web --help                     show this help

Env (used as fallback when flags absent):
  PORT    default 8080
  HOST    default 127.0.0.1

The web UI is a zero-dependency HTTP+chat layer (V28). It shells out
to \`node bin/darwin chat "<msg>"\` for each /api/chat request, so any
provider configured via \`darwin config add\` is available in the UI.
`;

// Parse a small whitelist of flags; reject anything we don't recognise
// so typos don't silently fall through to the server.
export function parseWebFlags(argv) {
  const out = {
    port: null,
    host: null,
    help: false,
    noOpen: false,
    detach: null, // null = not specified, true/false after parse
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--port') {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error('darwin web: --port requires a value');
      }
      out.port = v;
      continue;
    }
    if (a === '--host') {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error('darwin web: --host requires a value');
      }
      out.host = v;
      continue;
    }
    if (a.startsWith('--port=')) {
      out.port = a.slice('--port='.length);
      continue;
    }
    if (a.startsWith('--host=')) {
      out.host = a.slice('--host='.length);
      continue;
    }
    if (a === '--no-open') {
      out.noOpen = true;
      continue;
    }
    if (a === '--detach' || a === '-d') {
      out.detach = true;
      continue;
    }
    if (a === '--no-detach') {
      out.detach = false;
      continue;
    }
    throw new Error(`darwin web: unknown flag: ${a}`);
  }
  return out;
}

function validatePort(port) {
  if (port === null) {
    return null;
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`darwin web: invalid --port "${port}" (expected integer 1-65535)`);
  }
  return String(n);
}

function validateHost(host) {
  if (host === null) {
    return null;
  }
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
    throw new Error(`darwin web: invalid --host "${host}"`);
  }
  return host;
}

function buildWebEnv({ port, host }, envIn) {
  const env = { ...envIn };
  if (port !== null) {
    env.PORT = port;
  }
  if (host !== null) {
    env.HOST = host;
  }
  return env;
}

function failAndExit(msg) {
  process.stderr.write('x ' + msg + '\n');
  process.stderr.write('Run `darwin web --help` for usage.\n');
  process.exit(1);
}

// Reject a detach launch when a live server is already recorded.
function checkNotAlreadyRunning(_port, _host) {
  const existing = readPidfile();
  if (!existing) {
    return;
  }
  if (isPidAlive(existing.pid)) {
    failAndExit(
      `darwin web: a server is already running (pid ${existing.pid}` +
        `, port ${existing.port || '?'}, host ${existing.host || '?'}). ` +
        `Run \`darwin web stop\` first, or \`darwin web status\` to inspect.`,
    );
  }
  // Stale pidfile (pid dead). Clear it so the new launch starts clean.
  clearPidfile();
}

export function webStart(argv = []) {
  let flags;
  try {
    flags = parseWebFlags(argv);
  } catch (e) {
    failAndExit(e.message);
    return;
  }

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  let port;
  let host;
  try {
    port = validatePort(flags.port);
    host = validateHost(flags.host);
  } catch (e) {
    failAndExit(e.message);
    return;
  }

  const env = buildWebEnv({ port, host }, process.env);
  // The env we forward to the child already has PORT/HOST set when the
  // user passed --port/--host. When they did not, we let the child
  // fall through to its own defaults (8080/127.0.0.1).
  const effectivePort = port || env.PORT || '8080';
  const effectiveHost = host || env.HOST || '127.0.0.1';
  const detach = flags.detach === true;

  if (detach) {
    checkNotAlreadyRunning(effectivePort, effectiveHost);
  }

  const child = spawn(process.execPath, [SERVER_JS], {
    stdio: detach ? 'ignore' : 'inherit',
    env,
    detached: detach,
  });

  if (detach) {
    // Unref so the parent can exit without keeping the child alive
    // (inheriting the parent's stdio would otherwise keep the
    // event loop alive).
    child.unref();
    writePidfile({
      pid: child.pid,
      port: Number(effectivePort),
      host: effectiveHost,
    });
    process.stdout.write(
      `darwin web: detached (pid ${child.pid}, http://${effectiveHost}:${effectivePort})\n` +
        `  pidfile: ${getPidfilePath()}\n` +
        `  stop with: darwin web stop\n`,
    );
    process.exit(0);
    return;
  }

  // Foreground mode (default): forward signals and propagate exit code.
  const forward = (sig) => {
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch (_) {
        /* ignore */
      }
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

// --- V30: web stop / web status (pidfile-driven) -----------------

export function webStop(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'darwin web stop -- stop the background server (V30)\n\nReads ~/.darwin/web.pid, sends SIGTERM (then SIGKILL after 2s),\nand removes the pidfile. No-op (exit 0) if no server is running.\n',
    );
    return;
  }
  const info = readPidfile();
  if (!info) {
    process.stdout.write(
      'darwin web: no server is running (no pidfile at ' + getPidfilePath() + ').\n',
    );
    process.exit(0);
    return;
  }
  if (!isPidAlive(info.pid)) {
    process.stdout.write(
      'darwin web: pidfile is stale (pid ' + info.pid + ' not alive). Removing.\n',
    );
    clearPidfile();
    process.exit(0);
    return;
  }
  const ok = stopServer(info.pid, 2000);
  clearPidfile();
  if (ok) {
    process.stdout.write('darwin web: stopped (pid ' + info.pid + ').\n');
    process.exit(0);
    return;
  }
  process.stderr.write('x darwin web: failed to stop pid ' + info.pid + ' even with SIGKILL.\n');
  process.exit(1);
}

export function webStatus(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'darwin web status -- show the background server status (V30)\n\nReads ~/.darwin/web.pid and reports pid / port / host / uptime.\nExit 0 if running or absent; exit 1 only if pidfile is stale.\n',
    );
    return;
  }
  const desc = describeServer();
  if (desc.state === 'absent') {
    process.stdout.write('darwin web: no server is running.\n');
    process.exit(0);
    return;
  }
  if (desc.state === 'stale') {
    process.stderr.write(
      'x darwin web: pidfile is stale (pid ' +
        desc.pid +
        ' not alive). Run `darwin web stop` to clean up.\n',
    );
    process.exit(1);
    return;
  }
  // state === 'running'
  const uptime = formatUptime(desc.started_at);
  process.stdout.write('darwin web: running\n');
  process.stdout.write('  pid:        ' + desc.pid + '\n');
  process.stdout.write(
    '  url:        http://' + (desc.host || '?') + ':' + (desc.port || '?') + '\n',
  );
  process.stdout.write('  started_at: ' + (desc.started_at || '?') + '\n');
  process.stdout.write('  uptime:     ' + uptime + '\n');
  process.stdout.write('  pidfile:    ' + getPidfilePath() + '\n');
  process.exit(0);
}
