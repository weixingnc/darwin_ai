/**
 * head — Darwin built-in tool (V3_ROADMAP P1). No npm deps, no shell.
 * Walks `cwd` recursively, returns first N lines of each matching file.
 * Result: { files: [{ file, lines: string[] }] }. Errors skipped silently.
 * n=0 → unlimited. Empty file → { file, lines: [] }. Symlinks followed.
 * Walker + include-glob compiler are duplicated from wc.js to keep
 * head a single-responsibility leaf tool (no shared module).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const DEFAULT_CWD = process.cwd();
const DEFAULT_INCLUDE = '**/*';
const DEFAULT_N = 10;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Compile a glob include pattern into a posix-path tester. Mirrors wc.js. */
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

/** First N lines of one file. null on skip, [] for empty. GNU head semantics. */
function headLines(absPath, n) {
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
  if (content.length === 0) {
    return [];
  }
  const all = content.split('\n');
  // trailing '' from final \n is not a line in GNU head — drop it
  if (all[all.length - 1] === '') {
    all.pop();
  }
  return n === 0 ? all : all.slice(0, n);
}

function pickString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function pickInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const head = {
  name: 'head',
  description:
    'Return the first N lines of each file under cwd. ' +
    'Returns { files: [{file, lines: string[]}] } with cwd-relative posix paths. ' +
    'No shell. n=0 means unlimited. Errors are skipped silently.',
  schema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'root directory to walk (default: process.cwd())' },
      include: {
        type: 'string',
        description: 'optional glob to restrict file types (e.g. "**/*.js"); defaults to "**/*"',
      },
      n: {
        type: 'integer',
        description: 'number of lines to return per file (default: 10); 0 means unlimited',
      },
    },
    required: [],
  },
  async execute({ cwd, include, n } = {}) {
    const root = pickString(cwd, DEFAULT_CWD);
    const inc = pickString(include, DEFAULT_INCLUDE);
    const limit = pickInt(n, DEFAULT_N);
    const test = compileInclude(inc);
    let files;
    try {
      files = walk(root);
    } catch {
      return { files: [] };
    }
    const out = [];
    for (const full of files) {
      const rel = toPosix(full.replace(root, '').replace(/^[/\\]+/, ''));
      if (!test(rel)) {
        continue;
      }
      const lines = headLines(full, limit);
      if (lines === null) {
        continue;
      }
      out.push({ file: rel, lines });
    }
    out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { files: out };
  },
};

export default head;
