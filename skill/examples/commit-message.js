/**
 * commit-message — Darwin skill: generate a conventional commit message from a diff.
 * ADR-009 mechanical stub. Options: type, scope, breaking.
 *
 * **Contract (V10.5)**: execute() returns `{ output, suggested, stats }` (multi-key; `output` is the LLM-facing string, `suggested` + `stats` are programmatic hints; `issues: []` may appear on the `invalid` input path). See `docs/skill-contract.md` for the full sibling shape table and migration guide.
 */
export const commitMessage = {
  name: 'commit-message',
  description: 'Generate a conventional commit message from a diff (v3+ P1 catalog item).',
  triggers: ['commit', 'commit message', 'commitmsg', 'commit-msg', '提交信息', '生成 commit'],
  systemPromptHint:
    'User wants a commit message. Follow conventional commits (type: subject); keep subject < 50 chars; imperative mood.',
  async execute(input, context = {}) {
    const resolved = resolveDiff(input, context);
    if (resolved === null) {
      return blankCommit('chore: empty diff');
    }
    if (resolved === 'invalid') {
      return { ...blankCommit('chore: invalid input'), issues: [] };
    }
    const opts = context && typeof context.options === 'object' ? context.options : {};
    const files = Array.isArray(resolved) ? resolved : [{ path: '<input>', diff: resolved }];
    return buildCommit(collectPaths(files, resolved), computeStats(files), resolved, opts);
  },
};

function collectPaths(files, resolved) {
  const out = files.map((f) => f.path).filter((p) => p && p !== '<input>');
  if (out.length > 0 || Array.isArray(resolved)) {
    return out;
  }
  const re = /^diff --git a\/(.+?) b\//gm;
  let m;
  while ((m = re.exec(String(resolved))) !== null) {
    out.push(m[1]);
  }
  return out;
}

function buildCommit(paths, stats, resolved, opts) {
  const type = opts.type || inferType(paths, resolved);
  const scope = opts.scope || inferScope(paths);
  const breaking = !!opts.breaking;
  const firstName = paths[0] ? paths[0].split('/').pop() : `${stats.files_changed} files`;
  const cleaned = firstName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9-]+/g, ' ')
    .trim();
  const subject = truncate(cleaned || `update ${stats.files_changed} files`, 48);
  const header = `${type}${scope ? '(' + scope + ')' : ''}${breaking ? '!' : ''}: ${subject}`;
  const lines = [header];
  if (stats.files_changed + stats.insertions + stats.deletions > 0) {
    lines.push(`- ${stats.files_changed} files, +${stats.insertions} -${stats.deletions}`);
  }
  if (breaking) {
    lines.push('BREAKING CHANGE: ' + subject);
  }
  const footer = breaking ? 'BREAKING CHANGE: ' + subject : '';
  return {
    output: lines.join('\n'),
    suggested: { type, scope, subject, body: '', breaking, footer },
    stats,
  };
}

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

function blankCommit(output) {
  return {
    output,
    suggested: { type: 'chore' },
    stats: { files_changed: 0, insertions: 0, deletions: 0 },
  };
}

function computeStats(files) {
  let fc = 0,
    ins = 0,
    del = 0;
  for (const f of files) {
    const d = String(f.diff);
    if (/^Binary files/.test(d)) {
      fc += 1;
      continue;
    }
    if (/^rename from/.test(d)) {
      fc += 1;
      continue;
    }
    for (const ln of d.split('\n')) {
      if (/^diff --git/.test(ln)) {
        fc += 1;
      } else if (/^\+\+\+/.test(ln) || /^---/.test(ln)) {
        continue;
      } else if (/^\+/.test(ln)) {
        ins += 1;
      } else if (/^-/.test(ln)) {
        del += 1;
      }
    }
  }
  return { files_changed: fc, insertions: ins, deletions: del };
}

function inferType(paths, diff) {
  const hay = paths.join(' ');
  if (/\.md$/.test(hay) || /(^|\/)docs\//.test(hay)) {
    return 'docs';
  }
  if (/\.test\.[jt]sx?$/.test(hay) || /(^|\/)tests?\//.test(hay)) {
    return 'test';
  }
  if (/(^|\/)(package\.json|package-lock\.json)$/.test(hay)) {
    return 'chore';
  }
  const head = typeof diff === 'string' ? diff.split('\n').slice(0, 3).join(' ') : '';
  if (/\b(fix|bug)(:|\b)/i.test(head)) {
    return 'fix';
  }
  return 'feat';
}

function inferScope(paths) {
  if (paths.length === 0) {
    return undefined;
  }
  const scopes = paths.map(scopeOf).filter(Boolean);
  if (scopes.length === 0) {
    return undefined;
  }
  const first = scopes[0];
  return scopes.every((s) => s === first) ? first : undefined;
}

function scopeOf(p) {
  if (p.startsWith('evolution/')) {
    const seg = (p.split('/')[1] || '').replace(/\.[^.]+$/, '');
    return ['apply', 'audit', 'propose', 'verify'].includes(seg) ? seg : 'evolution';
  }
  if (p.startsWith('tool/builtins/')) {
    return 'tool';
  }
  if (p.startsWith('skill/examples/')) {
    return 'skill';
  }
  if (p.startsWith('core/')) {
    return 'core';
  }
  if (p.startsWith('tests/')) {
    return 'test';
  }
  return null;
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

export default commitMessage;
