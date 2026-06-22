/**
 * bin/lib/web-pidfile.js -- V30: pidfile management for `darwin web`.
 *
 * The web server is normally a foreground process (stdio: 'inherit'),
 * but V30 adds `--detach` so users can launch it in the background
 * and then `darwin web stop` / `darwin web status` it. To support
 * stop/status we need a stable on-disk handle: the pidfile.
 *
 * Layout (matches Darwin's existing userPath convention from
 * bin/lib/_shared.js, which already uses homedir() + .darwin):
 *   ~/.darwin/web.pid
 *
 * File format: JSON
 *   {
 *     "pid":       12345,           // process id of the child
 *     "port":      8080,            // port the server is bound to
 *     "host":      "127.0.0.1",     // host the server is bound to
 *     "started_at": "2026-06-22T00:34:56.789Z"  // ISO timestamp
 *   }
 *
 * Why JSON, not just `<pid>\n`:
 *   1. `darwin web status` can show port/host/uptime without re-deriving
 *      them from environment or argv (which may be lost after detach).
 *   2. Future V31+ fields (e.g. log path, build sha) can be added
 *      without breaking existing stop/status invocations.
 *   3. Cheap to parse; the pidfile is read at most once per CLI call.
 *
 * Concurrency: pidfile ops are not atomic across writers. We tolerate
 * that for the V30 use case (one user, one server); a future
 * V31+ could add a `.lock` companion file if multi-launch races
 * become a real problem.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kill } from 'node:process';

const USER_DIR = join(homedir(), '.darwin');
const PIDFILE = join(USER_DIR, 'web.pid');

function ensureUserDir() {
  try {
    mkdirSync(USER_DIR, { recursive: true });
  } catch {
    /* best-effort; writeFileSync will surface the real error */
  }
}

// Best-effort liveness check. `process.kill(pid, 0)` does not send a
// signal; it just checks whether the pid exists and is signallable.
// Throws ESRCH if no such pid, EPERM if it exists but we lack rights.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') {
      return true; // exists, we just can't signal
    }
    return false; // ESRCH or any other error -> dead
  }
}

export function getPidfilePath() {
  return PIDFILE;
}

export function readPidfile() {
  if (!existsSync(PIDFILE)) {
    return null;
  }
  let raw;
  try {
    raw = readFileSync(PIDFILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePidfile({ pid, port, host }) {
  ensureUserDir();
  const payload = {
    pid: Number(pid),
    port: Number(port) || null,
    host: host || null,
    started_at: new Date().toISOString(),
  };
  writeFileSync(PIDFILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function clearPidfile() {
  try {
    if (existsSync(PIDFILE)) {
      unlinkSync(PIDFILE);
    }
  } catch {
    /* ignore */
  }
}

// SIGTERM the pid, wait up to `ms` for it to die, then SIGKILL if
// still alive. Returns true if the process is gone after the call.
export function stopServer(pid, ms = 2000) {
  if (!isPidAlive(pid)) {
    return true;
  }
  try {
    kill(pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    // 50ms spin
    const until = Date.now() + 50;
    while (Date.now() < until) {
      /* spin */
    }
  }
  // Still alive after grace period: SIGKILL.
  if (isPidAlive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  return !isPidAlive(pid);
}

// Format uptime in human-readable form. V30: just minutes/hours.
export function formatUptime(startedAt) {
  if (!startedAt) {
    return 'unknown';
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return 'unknown';
  }
  const deltaMs = Date.now() - start;
  if (deltaMs < 0) {
    return 'just started';
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ${sec % 60}s`;
  }
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// Status info: returns one of
//   { state: 'absent' }                                  -- no pidfile
//   { state: 'running', pid, port, host, started_at }    -- alive
//   { state: 'stale',  pid, port, host, started_at }     -- pidfile there but pid is dead
export function describeServer() {
  const info = readPidfile();
  if (!info) {
    return { state: 'absent' };
  }
  const alive = isPidAlive(info.pid);
  if (alive) {
    return { state: 'running', ...info };
  }
  return { state: 'stale', ...info };
}
