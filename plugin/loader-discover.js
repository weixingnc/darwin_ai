/**
 * plugin/loader-discover.js -- the `discover(dirPath)` function extracted
 * from createPluginLoader() so the factory stays under the
 * max-lines-per-function=200 cap.
 *
 * V12: discover is a recursive one-level walk that finds .js files,
 * filters ignorable dirs, and delegates to tryLoadFile. The "register
 * on first sight" side-effect (added by the overnight hermes work) is
 * preserved here so the watcher + manual discover() both end up
 * calling load() through the same path.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const IGNORE_DIR = (name) => name === 'node_modules' || name.startsWith('.');
const isJsFile = (entry) => entry.isFile() && entry.name.endsWith('.js');

/**
 * @param {object} ctx - { tryLoadFile }
 * @returns {function(string): Promise<Array<{name, path}>>}
 */
export function createDiscoverFn(ctx) {
  const { tryLoadFile } = ctx;
  return async function discover(dirPath) {
    const root = resolve(dirPath);
    let entries;
    try {
      if (!(await stat(root)).isDirectory()) {
        return [];
      }
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      const full = join(root, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIR(e.name)) {
          continue;
        }
        const sub = await discover(full);
        for (const item of sub) {
          out.push(item);
        }
        continue;
      }
      if (!isJsFile(e)) {
        continue;
      }
      try {
        const r = await tryLoadFile(full);
        if (r && r.ok) {
          out.push({ name: r.value.name, path: full, plugin: r.value.plugin });
        }
      } catch {
        // discovery is best-effort; skip files that fail to import
      }
    }
    return out;
  };
}
