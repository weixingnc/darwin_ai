/**
 * Write-file — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Writes UTF-8 content to a file, overwriting if it exists. Minimal, no
 * dependencies beyond node:fs. Used by Darwin's apply() (proposal execution)
 * to write new/modified files in the whitelist dirs (ADR-005).
 *
 * Contract (mirrors `tool/builtins/echo.js`):
 *   - name: 'write-file' (stable string — Darwin tool registry looks it up by name)
 *   - description: human-readable
 *   - schema: JSON-Schema-ish
 *   - execute({ path: string, content: string }) → { ok: true, bytes: number, path: string }
 *
 * Errors (v1 D-3 fix: surface, never silently swallow):
 *   - non-string path or content → TypeError
 *   - EACCES / ENOENT (missing dir) / EISDIR → Error with err.code preserved
 *
 * Safety: This tool will OVERWRITE existing files. Darwin's apply() gate
 * (evolution/apply.js) is responsible for verifying the path is whitelisted
 * (ADR-005) before invoking this tool. Callers in user-facing flows should
 * also pass the path through the boundary check (core/self-evolution.js
 * `defaultBoundary`) before calling.
 *
 * LLM gate (ADR-009): mechanical (no LLM calls).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const writeFile = {
  name: 'write-file',
  description: 'Write file contents (overwrites existing). Returns { ok, bytes, path }.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute or cwd-relative file path' },
      content: { type: 'string', description: 'UTF-8 content to write' },
    },
    required: ['path', 'content'],
  },
  async execute({ path, content } = {}) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('write-file.execute: path must be non-empty string');
    }
    if (typeof content !== 'string') {
      throw new TypeError('write-file.execute: content must be string');
    }
    // mkdirSync recursive for parent dirs (best-effort, ignore EEXIST).
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; writeFileSync will surface the real error if dir creation failed
    }
    writeFileSync(path, content, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(content, 'utf8'), path };
  },
};

export default writeFile;
