/**
 * Bash — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Runs a shell command via `child_process.spawnSync` and returns its
 * captured stdout/stderr + exit code + duration. Hard timeout: 30s.
 *
 * Contract (mirrors `tool/builtins/echo.js`):
 *   - name: 'bash' (stable string — Darwin tool registry looks it up by name)
 *   - description: human-readable
 *   - schema: JSON-Schema-ish
 *   - execute({ command: string, args?: string[], cwd?: string, env?: object, timeoutMs?: number })
 *     → { stdout: string, stderr: string, exitCode: number|null, durationMs: number, timedOut: boolean }
 *
 * Security / safety (F-3 lesson + v1 hygiene B-1):
 *   - Uses `spawnSync` (NOT `execSync` with shell:true) to avoid shell-injection
 *     and surprise-eval bugs. The command is the executable; arguments are a
 *     separate string array.
 *   - The shell IS used ONLY when `shell: true` is explicitly passed in opts
 *     (not exposed via the tool schema; reserved for future internal use).
 *   - Hard 30s timeout at the schema level (per brief); callers may opt-down
 *     via `timeoutMs` (min 1s, max 300s).
 *
 * Errors:
 *   - non-string command / non-array args → TypeError
 *   - ENOENT (command not found) → error surfaces in `error.code`
 *   - timeout (kill due to timeout) → `timedOut: true`, exitCode: null
 *
 * LLM gate (ADR-009): mechanical (no LLM calls).
 */

import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000; // 5 min ceiling — defensive cap

function resolveTimeoutMs(opts) {
  if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
    return Math.min(opts.timeoutMs, MAX_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_MS;
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('bash.execute: command must be non-empty string');
  }
}

function validateArgs(args) {
  if (args === undefined) {
    return [];
  }
  if (!Array.isArray(args)) {
    throw new TypeError('bash.execute: args must be array of strings when provided');
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new TypeError('bash.execute: each args entry must be string');
    }
  }
  return args;
}

function buildSpawnOpts(cwd, env, timeoutMs) {
  const spawnOpts = {
    encoding: 'utf8',
    timeout: resolveTimeoutMs({ timeoutMs }),
    maxBuffer: 50 * 1024 * 1024,
  };
  if (typeof cwd === 'string' && cwd.length > 0) {
    spawnOpts.cwd = cwd;
  }
  if (env && typeof env === 'object') {
    spawnOpts.env = { ...process.env, ...env };
  }
  return spawnOpts;
}

function formatResult(result, durationMs, effectiveTimeout) {
  return {
    stdout: result.stdout === null || result.stdout === undefined ? '' : String(result.stdout),
    stderr: result.stderr === null || result.stderr === undefined ? '' : String(result.stderr),
    exitCode: result.status,
    durationMs,
    timedOut: result.signal === 'SIGTERM' && durationMs >= effectiveTimeout,
    signal: result.signal || null,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
  };
}

export const bash = {
  name: 'bash',
  description:
    'Run a shell command via spawnSync (no shell). Hard timeout 30s. ' +
    'Returns { stdout, stderr, exitCode, durationMs, timedOut }.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'executable to run (e.g. "ls", "node")' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'arguments as a string array (NO shell parsing)',
      },
      cwd: { type: 'string', description: 'working directory (default: process.cwd())' },
      env: {
        type: 'object',
        description: 'env overrides (merged onto process.env, not replacing it)',
      },
      timeoutMs: {
        type: 'number',
        description: 'timeout in ms (default 30000, max 300000)',
      },
    },
    required: ['command'],
  },
  async execute({ command, args, cwd, env, timeoutMs } = {}) {
    validateCommand(command);
    const safeArgs = validateArgs(args).slice();
    const spawnOpts = buildSpawnOpts(cwd, env, timeoutMs);
    const effectiveTimeout = spawnOpts.timeout;
    const t0 = Date.now();
    const result = spawnSync(command, safeArgs, spawnOpts);
    const durationMs = Date.now() - t0;
    return formatResult(result, durationMs, effectiveTimeout);
  },
};

export default bash;
