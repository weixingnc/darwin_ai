/**
 * Evolution Learn — PR-S2 (v3+ SelfEvolution P0).
 *
 * ADR-008 learn-closed loop: every rollback appends a markdown rule to
 * `memory/learnings/evolution-rules.md`. The next propose() reads this file
 * (PR-S3) to bias rule selection.
 *
 * Format: `- <ISO date>: <insight>\n`
 *
 * LLM gate (ADR-009): learn is mechanical (file append), NEVER calls LLM.
 * The insight TEXT is authored by humans (e.g. after a rollback, darwin-coder
 * writes "改 streaming 类 provider 先 lint 本地") — Darwin just persists it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LEARN_DIR = path.join(REPO_ROOT, 'memory', 'learnings');
const RULES_FILE = path.join(LEARN_DIR, 'evolution-rules.md');

/**
 * Validate insight shape.
 */
function validateInsight(insight) {
  if (typeof insight !== 'string' || !insight.trim()) {
    throw new TypeError('[evolution/learn] insight must be non-empty string');
  }
  if (insight.length > 2000) {
    throw new TypeError('[evolution/learn] insight must be <= 2000 chars');
  }
}

/**
 * Count existing rules in the rules file (best-effort: each rule starts with `- `).
 */
function countRules(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split('\n').filter((l) => l.startsWith('- ')).length;
}

/**
 * PR-S2 learn — append a rule to `memory/learnings/evolution-rules.md`.
 *
 * @param {string} insight — human-readable learning (markdown friendly).
 * @param {object} [opts]
 * @param {string} [opts.learnDir] — override LEARN_DIR (tests inject tmpdir)
 * @returns {Promise<{ rules_path: string, rules_count: number, line: string }>}
 */
export async function appendInsight(insight, opts = {}) {
  validateInsight(insight);

  const learnDir = opts.learnDir || LEARN_DIR;
  const rulesPath = path.join(learnDir, 'evolution-rules.md');
  fs.mkdirSync(learnDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date}: ${insight.trim()}\n`;

  // Ensure file exists with header so the first append is human-readable.
  if (!fs.existsSync(rulesPath)) {
    fs.writeFileSync(
      rulesPath,
      '# Evolution Rules\n\nRules learned from rollbacks. Human-curated.\n\n',
      'utf8',
    );
  }
  fs.appendFileSync(rulesPath, line, 'utf8');

  const rules_count = countRules(rulesPath);

  evolutionBus.emit(EVENTS.EVOLUTION_LEARN, {
    insight: insight.trim(),
    rules_path: rulesPath,
    rules_count,
  });

  return { rules_path: rulesPath, rules_count, line };
}

/**
 * Backwards-compat alias: core/self-evolution.js calls `learn(insight)`.
 * Map to appendInsight.
 */
export async function learn(insight, opts) {
  return appendInsight(insight, opts);
}

export const _internal = {
  validateInsight,
  countRules,
  LEARN_DIR,
  RULES_FILE,
  REPO_ROOT,
};
