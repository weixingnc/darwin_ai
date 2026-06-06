#!/usr/bin/env node
/**
 * Size check: enforces single-file < 1000 lines hard constraint.
 * Run via pre-commit hook or `npm run size-check`.
 *
 * v1 lesson: DarwinCore.js 2621 行 / SelfEvolution.js 1590 行 / SkillManager.js 1366 行
 * v2 硬约束: every source file must be < 1000 lines, or PR is rejected.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_LINES = 1000;
// PR 11a/11b/12a 教训 (2026-06-06): plugin/ tests/ adapter/ 也需守 1000 行硬约束, 加进 SCAN_DIRS
const SCAN_DIRS = ['core', 'lifecycle', 'provider', 'plugin', 'adapter', 'tool', 'skill', 'memory', 'demo', 'scripts', 'tests'];
const SKIP_FILES = new Set([]);

function getFiles() {
  try {
    // 1. Staged files (in pre-commit)
    const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && SCAN_DIRS.some((d) => f.startsWith(d + '/')) && f.endsWith('.js'));

    if (staged.length > 0) {
      return staged;
    }

    // 2. All tracked source files (in CI / local)
    const tracked = execSync('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && SCAN_DIRS.some((d) => f.startsWith(d + '/')) && f.endsWith('.js'));

    return tracked;
  } catch {
    return [];
  }
}

function countLines(file) {
  try {
    const content = readFileSync(file, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

const files = getFiles();
let violations = 0;

for (const f of files) {
  if (SKIP_FILES.has(f)) {
    continue;
  }
  const lines = countLines(f);
  const marker = lines > MAX_LINES ? '✗' : '✓';
  console.log(`${marker} ${f}: ${lines} lines`);
  if (lines > MAX_LINES) {
    violations++;
  }
}

if (violations > 0) {
  console.error(`\n✗ ${violations} file(s) exceed ${MAX_LINES} lines. Split before commit.`);
  process.exit(1);
}

console.log(`\n✓ All ${files.length} file(s) within ${MAX_LINES} lines.`);
