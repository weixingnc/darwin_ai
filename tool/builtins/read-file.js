/**
 * Read-file — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Returns file contents as a UTF-8 string. Minimal, no dependencies beyond
 * node:fs. Used by Darwin itself to inspect repo state, and by subagents
 * (e.g. propose) to load source files for analysis.
 *
 * Contract (mirrors `tool/builtins/echo.js`):
 *   - name: 'read-file' (stable string — Darwin tool registry looks it up by name)
 *   - description: human-readable (Darwin uses it for systemHint wiring)
 *   - schema: JSON-Schema-ish (input validation lives at the tool-caller)
 *   - execute({ path: string }) → { content: string, bytes: number }
 *
 * Errors (v1 D-3 fix: surface, never silently swallow):
 *   - non-string path → TypeError
 *   - ENOENT (missing) → Error("read-file: ENOENT: <path>")
 *   - EACCES / EISDIR / other → Error("<message>") with err.code preserved
 *
 * LLM gate (ADR-009): mechanical (no LLM calls).
 */

import { readFileSync, statSync } from 'node:fs';

export const readFile = {
  name: 'read-file',
  description: 'Read file contents as UTF-8 string. Returns { content, bytes }.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute or cwd-relative file path' },
    },
    required: ['path'],
  },
  async execute({ path } = {}) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('read-file.execute: path must be non-empty string');
    }
    let bytes = 0;
    try {
      const st = statSync(path);
      bytes = st.size;
    } catch {
      // statSync may fail (ENOENT/EACCES) — let readFileSync surface the real error.
      bytes = 0;
    }
    const content = readFileSync(path, 'utf8');
    return { content, bytes };
  },
};

export default readFile;
