/**
 * Grep — Darwin built-in tool (V3_ROADMAP P1).
 *
 * Recursively walks a root directory and returns every line matching an
 * ECMAScript regex. Result shape: { matches: [{file, line, text}] } with
 * 1-indexed line numbers and cwd-relative posix paths. No npm deps.
 *
 * Errors:
 *   - non-string / empty pattern → TypeError
 *   - bad regex (e.g. '[') → TypeError (SyntaxError mapped to TypeError)
 *   - file read errors → skip silently, never throw out of execute
 *
 * LLM gate (ADR-009): mechanical (no LLM calls). Walker/glob-compiler are
 * duplicated from `tool/builtins/glob.js` to keep grep standalone.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DEFAULT_CWD = process.cwd();
const DEFAULT_INCLUDE = '**/*';
const DEFAULT_MAX_RESULTS = 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Compile a glob include pattern into a posix-path tester. */
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

/** Compile a search regex; map SyntaxError → TypeError for uniform bad-input errors. */
function compileSearch(pattern) {
  try {
    return new RegExp(pattern);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new TypeError(`grep.execute: invalid regex: ${err.message}`);
    }
    throw err;
  }
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

/** Read a file line-by-line, regex-test each line, push matches. Never throws. */
function scanFile(absPath, re, relPosix, out) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return;
  }
  if (st.size > MAX_FILE_BYTES) {
    return;
  }
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      out.push({ file: relPosix, line: i + 1, text: lines[i] });
    }
  }
}

/** Pick a string option, falling back to default if empty/missing. */
function pickString(value, fallback) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

/** Pick a number option, falling back to default if not finite. */
function pickNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

export const grep = {
  name: 'grep',
  description:
    'Search files under cwd for a regex pattern. Returns { matches: [{file, line, text}] }. ' +
    'No shell. cwd-relative posix paths.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'ECMAScript regex pattern (e.g. "TODO.*fixme")' },
      cwd: { type: 'string', description: 'root directory to walk (default: process.cwd())' },
      include: {
        type: 'string',
        description: 'optional glob to restrict file types (e.g. "**/*.js"); defaults to "**/*"',
      },
      maxResults: {
        type: 'integer',
        description: 'cap total matches (default: 1000); 0 means unlimited',
      },
    },
    required: ['pattern'],
  },
  async execute({ pattern, cwd, include, maxResults } = {}) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new TypeError('grep.execute: pattern must be non-empty string');
    }
    const re = compileSearch(pattern);
    const root = pickString(cwd, DEFAULT_CWD);
    const inc = pickString(include, DEFAULT_INCLUDE);
    const cap = pickNumber(maxResults, DEFAULT_MAX_RESULTS);

    const test = compileInclude(inc);
    const all = walk(root);
    const matches = [];
    let capped = false;
    for (const full of all) {
      let rel;
      try {
        rel = relative(root, full);
      } catch {
        continue;
      }
      const relPosix = toPosix(rel);
      if (!test(relPosix)) {
        continue;
      }
      scanFile(full, re, relPosix, matches);
      if (cap > 0 && matches.length >= cap) {
        capped = true;
        break;
      }
    }
    if (!capped && cap > 0 && matches.length > cap) {
      matches.length = cap;
    }
    matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { matches };
  },
};

export default grep;
