// SkillWatcher — fs.watch hot-reload for SKILL.md (PR-21b, design §2.2/§4/§5).
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile, registerSkill, unregisterSkill } from './skill-loader.js';
const DEBOUNCE = 150;
const MD = /\.(md|markdown)$/i;
const NRE = /^[a-z0-9-]+$/;
const log = (m) => process?.stderr?.write?.('[skill-watcher] ' + m + '\n');
export function watchSkillsDir(skillsDir, registry, opts) {
  const ms = opts?.debounceMs ?? DEBOUNCE;
  const ignore = opts?.ignore || ['node_modules', '.git'];
  const dir = path.resolve(skillsDir);
  const timers = new Map();
  const errs = [];
  let w = null;
  let closed = false;
  const fire = (err) => {
    h.paused = true;
    for (const f of errs.slice()) {
      try {
        f(err);
      } catch {
        /* swallow */
      }
    }
  };
  const unreg = (abs) => {
    const b = path.basename(abs, path.extname(abs)).toLowerCase();
    if (NRE.test(b)) {
      unregisterSkill(registry, b);
    }
  };
  const apply = (abs, type) => {
    if (type === 'rename' && !fs.existsSync(abs)) {
      return unreg(abs);
    }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return unreg(abs);
    }
    const entry = parseSkillFile(abs, content);
    if (!entry) {
      log('reparse failed, keeping previous entry for ' + abs);
      return;
    }
    registerSkill(registry, entry);
  };
  const h = {
    paused: false,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
      try {
        w?.close();
      } catch {
        /* already closed */
      }
    },
    on(ev, fn) {
      if (ev === 'error' && typeof fn === 'function') {
        errs.push(fn);
      }
    },
  };
  try {
    w = fs.watch(skillsDir, { recursive: false }, (type, fn) => {
      if (closed || !fn || !MD.test(fn)) {
        return;
      }
      const base = path.basename(fn);
      for (const p of ignore) {
        if (p && (base === p || base.startsWith(p + '.'))) {
          return;
        }
      }
      const abs = path.join(dir, fn);
      const old = timers.get(abs);
      if (old) {
        clearTimeout(old);
      }
      const tick = () => {
        timers.delete(abs);
        if (closed) {
          return;
        }
        try {
          apply(abs, type);
        } catch (err) {
          log('runtime error on ' + abs + ': ' + err.message);
          fire(err);
        }
      };
      timers.set(abs, setTimeout(tick, ms));
    });
  } catch (err) {
    log('cannot watch "' + skillsDir + '": ' + err.message);
    h.paused = true;
    h.error = err;
    return h;
  }
  w.on('error', (err) => {
    if (!closed) {
      log('watcher error, paused: ' + err.message);
      fire(err);
    }
  });
  return h;
}

export function closeWatch(handle) {
  handle?.close?.();
}
