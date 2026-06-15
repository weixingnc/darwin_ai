/**
 * Glob — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Recursively walks a directory and returns file paths matching a glob-like
 * pattern. Minimal: NO new dependencies (no `glob` / `minimatch` npm package).
 *
 * Supported pattern syntax (deliberately small, covers 95% of Darwin's needs):
 *   - `*`        matches any chars except `/`     (single segment wildcard)
 *   - `**`       matches any chars including `/`  (recursive wildcard)
 *   - `?`        matches one char except `/`
 *   - `[abc]`    matches one char in set          (POSIX character class)
 *   - `[!abc]`   matches one char NOT in set
 *   - other chars are literal (including `.` — no regex magic)
 *
 * Contract (mirrors `tool/builtins/echo.js`):
 *   - name: 'glob' (stable string)
 *   - description: human-readable
 *   - schema: JSON-Schema-ish
 *   - execute({ pattern: string, cwd?: string }) → { files: string[] }
 *
 * Errors:
 *   - non-string pattern → TypeError
 *   - ENOENT (missing cwd) → error surfaces in stderr / result.error
 *
 * LLM gate (ADR-009): mechanical (no LLM calls).
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DEFAULT_CWD = process.cwd();

/**
 * Compile a pattern string into a function that tests a relative path.
 * The path uses `/` as separator (normalized from OS sep).
 * @param {string} pattern
 * @returns {(relPosix: string) => boolean}
 */
function compilePattern(pattern) {
  // Build a regex source by walking the pattern char-by-char.
  // The regex will be anchored with ^ and $ for full match.
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      // `**` → match anything incl. `/`
      if (pattern[i + 1] === '*') {
        src += '.*';
        i++; // consume second `*`
        // optional trailing slash — `a/**/b` should match `a/b` and `a/x/b`
        if (pattern[i + 1] === '/') {
          i++; // consume `/`
          src += '(?:/.*)?';
        }
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '[') {
      // character class — find closing `]`
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        // malformed: treat as literal
        src += '\\[';
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      let cls;
      if (inner.startsWith('!')) {
        cls = '[^' + inner.slice(1).replace(/]/g, '\\]') + ']';
      } else {
        cls = '[' + inner.replace(/]/g, '\\]') + ']';
      }
      src += cls;
      i = end;
    } else {
      // literal char (escape regex specials)
      src += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  src += '$';
  const re = new RegExp(src);
  return (relPosix) => re.test(relPosix);
}

/**
 * Recursive walk returning all files (not dirs) as relative posix paths.
 * @param {string} cwd
 * @returns {string[]}
 */
function walk(cwd) {
  const out = [];
  const stack = [cwd];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      classifyEntry(dir, e, out, stack);
    }
  }
  return out;
}

/** Classify a readdir entry and push into out[] (files) or stack[] (dirs). Never throws. */
function classifyEntry(dir, e, out, stack) {
  const full = join(dir, e.name);
  try {
    if (e.isDirectory()) {
      stack.push(full);
    } else if (e.isFile()) {
      out.push(full);
    } else if (e.isSymbolicLink()) {
      followSymlink(full, out, stack);
    }
  } catch {
    // skip inaccessible entries; keep walking siblings
  }
}

/** Follow a symlink and classify the target. Never throws. */
function followSymlink(full, out, stack) {
  try {
    const st = statSync(full);
    if (st.isFile()) {
      out.push(full);
    } else if (st.isDirectory()) {
      stack.push(full);
    }
  } catch {
    // dangling / perms — skip
  }
}

function toPosix(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}

export const glob = {
  name: 'glob',
  description:
    'Glob file paths under cwd matching a pattern. Supports `*`, `**`, `?`, `[abc]`, `[!abc]`. ' +
    'No shell. Returns { files: string[] } with cwd-relative posix paths.',
  schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob pattern, e.g. "**/*.js", "src/**/index.{js,ts}", "[a-z]*.md"',
      },
      cwd: {
        type: 'string',
        description: 'root directory to walk (default: process.cwd())',
      },
    },
    required: ['pattern'],
  },
  async execute({ pattern, cwd } = {}) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new TypeError('glob.execute: pattern must be non-empty string');
    }
    const root = typeof cwd === 'string' && cwd.length > 0 ? cwd : DEFAULT_CWD;
    const test = compilePattern(pattern);
    const all = walk(root);
    const matches = [];
    for (const full of all) {
      let rel;
      try {
        rel = relative(root, full);
      } catch {
        continue;
      }
      const relPosix = toPosix(rel);
      if (test(relPosix)) {
        matches.push(relPosix);
      }
    }
    matches.sort();
    return { files: matches };
  },
};

export default glob;
