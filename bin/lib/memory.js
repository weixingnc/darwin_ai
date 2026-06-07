/**
 * darwin memory — read/write keys via default FilesystemBackend.
 *
 * `darwin memory show <key>` — print JSON-encoded value (or "(not set)").
 * `darwin memory set <key> <value>` — write value (string-only MVP).
 *
 * MVP scope: values are stored as strings to avoid CLI quoting hell.
 * JSON values can be handled by reading the file directly or via a future
 * `darwin memory set --json <key> <json>` flag.
 *
 * Default backend: filesystem (~/.darwin/memory/<key>.json).
 * Sqlite available via direct API, not yet wired into CLI.
 */

import { sharedBootstrap } from './_shared.js';

export async function memoryShow(key) {
  if (!key) {
    throw new Error('memory show: missing key. Usage: darwin memory show ctx:user-1');
  }
  const { memory } = await sharedBootstrap();
  const v = await memory.get(key);
  if (v === undefined || v === null) {
    console.log('(not set)');
    return;
  }
  if (typeof v === 'string') {
    console.log(v);
  } else {
    console.log(JSON.stringify(v, null, 2));
  }
}

export async function memorySet(key, value) {
  if (!key) {
    throw new Error('memory set: missing key. Usage: darwin memory set greeting "hello"');
  }
  if (!value) {
    throw new Error('memory set: missing value. Usage: darwin memory set greeting "hello"');
  }
  const { memory } = await sharedBootstrap();
  await memory.set(key, value);
  console.log(`✓ ${key} = ${value}`);
  // Also print the resolved file path so user knows where it lives
  // (filesystem backend default: ~/.darwin/memory/<safe-key>.json)
  console.log(`  (filesystem backend: ~/.darwin/memory/)`);
}
