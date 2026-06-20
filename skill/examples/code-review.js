/**
 * code-review — Darwin skill: review a code diff for common issues.
 * Stub: mechanical rule engine (6 LLM-free checks). Real LLM call lives
 * behind a TODO(p2) seam once SelfEvolution wires providers. ADR-009.
 * Input: string | context.diff | context.files=[{path, diff}].
 * Options (context.options): rules: string[]; maxLineLength: number (default 100).
 * **Contract (V10.5)**: execute() returns `{ output, summary, issues }` (multi-key; `output` is the LLM-facing string, `summary` + `issues` are programmatic hints). See `docs/skill-contract.md` for the full sibling shape table and migration guide.
 */
export const codeReview = {
  name: 'code-review',
  description: 'Review a code diff for common issues (v3+ P1 catalog item).',
  triggers: ['review', 'code review', 'lgtm', 'check code', 'code-review', '检查代码', '代码审查'],
  systemPromptHint:
    'User wants a code review. Be specific; cite line numbers; suggest concrete fixes; do not be pedantic.',
  // Built-in mechanical rules (name → severity → regex). All LLM-free.
  rules: [
    { name: 'no-todo', severity: 'warn', re: /\b(TODO|FIXME)\b/ },
    { name: 'no-console-log', severity: 'warn', re: /console\.log\s*\(/ },
    { name: 'no-debugger', severity: 'error', re: /\bdebugger\b/ },
    { name: 'no-var', severity: 'warn', re: /(^|\s)var\s+[A-Za-z_$]/ },
    {
      name: 'no-empty-function',
      severity: 'warn',
      re: /function\s*[A-Za-z_$0-9]*\s*\([^)]*\)\s*\{\s*\}/,
    },
    { name: 'max-line-length', severity: 'warn', re: null }, // special-cased (line.length > maxLen)
  ],
  async execute(input, context = {}) {
    const resolved = resolveDiff(input, context);
    if (resolved === null) {
      return blankReview('empty diff');
    }
    if (resolved === 'invalid') {
      return blankReview('invalid input');
    }
    const opts = context && typeof context.options === 'object' ? context.options : {};
    const rulesFilter = Array.isArray(opts.rules) ? new Set(opts.rules) : null;
    const maxLen = Number.isInteger(opts.maxLineLength) ? opts.maxLineLength : 100;
    const files = Array.isArray(resolved) ? resolved : [{ path: '<input>', diff: resolved }];
    const issues = [];
    for (const file of files) {
      scanFile(file, this.rules, rulesFilter, maxLen, issues);
    }
    return summarise(files, issues);
  },
};

function resolveDiff(input, context) {
  if (Array.isArray(context && context.files)) {
    return context.files;
  }
  if (context && typeof context.diff === 'string') {
    return context.diff.length === 0 ? null : context.diff;
  }
  if (typeof input === 'string') {
    return input.length === 0 ? null : input;
  }
  return 'invalid';
}

function blankReview(output) {
  return { output, summary: { total: 0, errors: 0, warnings: 0, files_reviewed: 0 }, issues: [] };
}

function scanFile(file, rules, rulesFilter, maxLen, out) {
  const lines = String(file.diff).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('-') || raw.startsWith('@@') || raw.startsWith('diff ')) {
      continue;
    }
    const line = raw.startsWith('+') ? raw.slice(1) : raw;
    for (const rule of rules) {
      if (rulesFilter && !rulesFilter.has(rule.name)) {
        continue;
      }
      if (rule.name === 'max-line-length') {
        if (line.length > maxLen) {
          out.push(mkIssue(file.path, i + 1, rule.name, rule.severity, line.length));
        }
        continue;
      }
      if (rule.re.test(line)) {
        out.push(mkIssue(file.path, i + 1, rule.name, rule.severity, line.length));
      }
    }
  }
}

function summarise(files, issues) {
  const errors = issues.filter((x) => x.severity === 'error').length;
  const summary = {
    total: issues.length,
    errors,
    warnings: issues.length - errors,
    files_reviewed: files.length,
  };
  return { output: `Code review complete. ${issues.length} issues found.`, summary, issues };
}

function mkIssue(file, line, rule, severity, lineLength) {
  return {
    file,
    line,
    rule,
    severity,
    message:
      rule === 'max-line-length'
        ? `line exceeds max length (${lineLength} chars)`
        : `flagged by rule ${rule}`,
  };
}

export default codeReview;
