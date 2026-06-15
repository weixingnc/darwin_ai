/**
 * wc — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Recursively walks a root directory and counts lines, words, bytes, and
 * file count across all files matching an `include` glob. Result shape:
 * { lines, words, bytes, files }. No npm deps, no shell.
 *
 * Counting semantics (GNU wc style):
 *   - lines  = count of `\n` characters in file content
 *   - words  = tokens from `content.trim().split(/\s+/)` (whitespace tokens)
 *   - bytes  = `Buffer.byteLength(content, 'utf8')`
 *   - files  = number of files successfully read
 *
 * Errors:
 *   - non-existent cwd → {0,0,0,0} (silent)
 *   - file read errors (ENOENT/EACCES) → skip silently, never throw out of execute
 *
 * LLM gate (ADR-009): mechanical (no LLM calls). Walker and include-glob
 * compiler are duplicated from `tool/builtins/grep.js` to keep wc standalone
 * (single-responsibility leaf tool).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const DEFAULT_CWD = process.cwd();
const DEFAULT_INCLUDE = '**/*';
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Compile a glob include pattern into a posix-path tester. Mirrors grep.js. */
function compileInclude(pattern) {
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*';
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          src += '(?:/.*)?';
        }
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        src += '\\[';
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      if (inner.startsWith('!')) {
        src += '[^' + inner.slice(1).replace(/]/g, '\\]') + ']';
      } else {
        src += '[' + inner.replace(/]/g, '\\]') + ']';
      }
      i = end;
    } else {
      src += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return (p) => new RegExp(src + '$').test(p);
}

/** Recursive walk returning absolute file paths. Symlinks followed. Never throws. */
function walk(cwd) {
  const out = [];
  const stack = [cwd];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      let kind = null;
      try {
        if (e.isDirectory()) {
          kind = 'd';
        } else if (e.isFile()) {
          kind = 'f';
        } else if (e.isSymbolicLink()) {
          const st = statSync(full);
          kind = st.isFile() ? 'f' : st.isDirectory() ? 'd' : null;
        }
      } catch {
        continue;
      }
      if (kind === 'f') {
        out.push(full);
      } else if (kind === 'd') {
        stack.push(full);
      }
    }
  }
  return out;
}

function toPosix(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Count lines/words/bytes for a single file. Never throws. Returns null on skip. */
function countFile(absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (st.size > MAX_FILE_BYTES) {
    return null;
  }
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) {
    return { lines: 0, words: 0, bytes: 0 };
  }
  // lines = number of '\n' chars (GNU wc -l semantics: file with no trailing \n
  // still counts lines present, e.g. "one\ntwo\nthree" → 2 newlines → 2 lines)
  const lines = (content.match(/\n/g) || []).length;
  // words = trim then split on whitespace
  const words = content
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return { lines, words, bytes };
}

/** Pick a string option, falling back to default if empty/missing. */
function pickString(value, fallback) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

export const wc = {
  name: 'wc',
  description:
    'Count lines, words, and bytes across files under cwd. Returns { lines, words, bytes, files }. ' +
    'No shell. cwd-relative posix paths.',
  schema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'root directory to walk (default: process.cwd())' },
      include: {
        type: 'string',
        description: 'optional glob to restrict file types (e.g. "**/*.js"); defaults to "**/*"',
      },
    },
    required: [],
  },
  async execute({ cwd, include } = {}) {
    const root = pickString(cwd, DEFAULT_CWD);
    const inc = pickString(include, DEFAULT_INCLUDE);
    const test = compileInclude(inc);
    let files;
    try {
      files = walk(root);
    } catch {
      return { lines: 0, words: 0, bytes: 0, files: 0 };
    }
    let totalLines = 0;
    let totalWords = 0;
    let totalBytes = 0;
    let totalFiles = 0;
    for (const full of files) {
      const rel = toPosix(full.replace(root, '').replace(/^[/\\]+/, ''));
      if (!test(rel)) {
        continue;
      }
      const c = countFile(full);
      if (c === null) {
        continue;
      }
      totalLines += c.lines;
      totalWords += c.words;
      totalBytes += c.bytes;
      totalFiles += 1;
    }
    return { lines: totalLines, words: totalWords, bytes: totalBytes, files: totalFiles };
  },
};

export default wc;
