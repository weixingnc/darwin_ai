/**
 * bin/lib/web.js -- V29-actual: `darwin web` subcommand.
 *
 * Wraps `node web/server.js` so users can launch the local web UI
 * through the standard CLI. Accepts --port and --host flags (or
 * env vars PORT/HOST as fall-through).
 *
 * Design choice: we spawn web/server.js as a child process rather
 * than importing it, for three reasons:
 *   1. web/server.js already has its own `if (import.meta.url === ...)`
 *      gate that calls listen() only when run as main. Importing
 *      would start a second listener on the same port.
 *   2. The web server's lifecycle (open sockets, env, file handles)
 *      is isolated from the parent CLI; a future `darwin web stop`
 *      subcommand can kill child pids by pattern without touching
 *      the parent.
 *   3. The server's stdout banner ("Darwin web UI listening on...")
 *      is preserved in the user's terminal exactly as it was when
 *      they ran `node web/server.js` directly, because we use
 *      stdio: 'inherit'.
 *
 * Sub-commands:
 *   darwin web                          start on default PORT (8080) / HOST (127.0.0.1)
 *   darwin web --port <N>               listen on port N (1-65535)
 *   darwin web --host <H>               bind to host H (default 127.0.0.1; '0.0.0.0' for all)
 *   darwin web --no-open                (V29.1 placeholder, currently ignored)
 *   darwin web --help                   show this subcommand's help
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_JS = join(REPO_ROOT, 'web', 'server.js');

const HELP = `darwin web -- start the local web UI (V29-actual)

Usage:
  darwin web                          start on default PORT (8080) / HOST (127.0.0.1)
  darwin web --port <N>               listen on port N (1-65535)
  darwin web --host <H>               bind to host H (default 127.0.0.1; '0.0.0.0' for all)
  darwin web --no-open                (V29.1 placeholder, currently ignored)
  darwin web --help                   show this help

Env (used as fallback when flags absent):
  PORT    default 8080
  HOST    default 127.0.0.1

The web UI is a zero-dependency HTTP+chat layer (V28). It shells out to
\`node bin/darwin chat "<msg>"\` for each /api/chat request, so any
provider configured via \`darwin config add\` is available in the UI.
`;

// Parse a small whitelist of flags; reject anything we don't recognise
// so typos don't silently fall through to the server.
export function parseWebFlags(argv) {
  const out = { port: null, host: null, help: false, noOpen: false };
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
      // V29.1 placeholder: future "auto-open browser" toggle. Ignored for now.
      out.noOpen = true;
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
  // Permissive: accept "0.0.0.0", "127.0.0.1", "::1", or a hostname.
  // The server itself will surface bind errors at startup.
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
    throw new Error(`darwin web: invalid --host "${host}"`);
  }
  return host;
}

export function buildWebEnv({ port, host }, envIn) {
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

  const child = spawn(process.execPath, [SERVER_JS], {
    stdio: 'inherit',
    env,
  });

  // Forward signals so Ctrl+C kills the child, not just the wrapper.
  const forward = (sig) => {
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      // Parent got Ctrl+C; exit cleanly so the shell prompt comes back.
      process.exit(0);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}
