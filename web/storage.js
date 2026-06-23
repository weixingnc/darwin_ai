/**
 * web/storage.js -- V43: client-side persistence helpers.
 *
 * Three small concerns, kept in one tiny file so the chat UI
 * does not have to wire its own localStorage plumbing:
 *   - conversations: array of { id, title, createdAt, updatedAt, messages }
 *     keyed by darwin.conversations.v1
 *   - activeConversationId: which conversation is open
 *   - prefs: misc UI prefs (e.g. last-used tab, sidebar width)
 *
 * Soft caps to keep the browser storage bounded:
 *   MAX_CONVS = 50  (oldest evicted)
 *   MAX_MSGS  = 200 per conversation
 * Exceeding the per-conv cap drops the oldest non-system messages
 * (we never drop the first user message; the title is derived
 * from it).
 *
 * The "id" is a small random base36 string generated client-side.
 * No server roundtrip; pure local state.
 */

/* global localStorage, document, window */
// V43: browser-side persistence. Loaded by web/index.html as
// <script src="./storage.js"> -- the functions below are exposed
// on window for the inline <script> in index.html to use.

const STORAGE_KEY_CONVS = 'darwin.conversations.v1';
const STORAGE_KEY_ACTIVE = 'darwin.activeConversation.v1';
const STORAGE_KEY_PREFS = 'darwin.prefs.v1';
const MAX_CONVS = 50;
const MAX_MSGS = 200;

// V43: every public function in this file is also assigned to
// window so the inline script in index.html can call them after
// the <script src="./storage.js"> tag loads.
function exposeToWindow() {
  if (typeof window === 'undefined') {
    return;
  } // not in browser (test only)
  const fns = {
    newId,
    loadConversations,
    saveConversations,
    getActiveId,
    setActiveId,
    getPrefs,
    setPrefs,
    appendMessage,
    deriveTitle,
    createConversation,
    deleteConversation,
    getConversation,
    putConversation,
    conversationToMarkdown,
    downloadText,
  };
  for (const [name, fn] of Object.entries(fns)) {
    window[name] = fn;
  }
}
if (typeof window !== 'undefined') {
  exposeToWindow();
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode: silently degrade */
  }
}

function loadConversations() {
  const arr = readJson(STORAGE_KEY_CONVS, []);
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr;
}

function saveConversations(arr) {
  writeJson(STORAGE_KEY_CONVS, arr);
}

function getActiveId() {
  return localStorage.getItem(STORAGE_KEY_ACTIVE) || null;
}

function setActiveId(id) {
  if (id) {
    localStorage.setItem(STORAGE_KEY_ACTIVE, id);
  } else {
    localStorage.removeItem(STORAGE_KEY_ACTIVE);
  }
}

function getPrefs() {
  return readJson(STORAGE_KEY_PREFS, { activeTab: 'chat' });
}

function setPrefs(p) {
  writeJson(STORAGE_KEY_PREFS, p);
}

// V43: append a message to a conversation, creating the conv if
// missing. Returns the (possibly new) conv. Trims to MAX_MSGS.
function appendMessage(conv, msg) {
  if (!conv) {
    return conv;
  }
  if (!Array.isArray(conv.messages)) {
    conv.messages = [];
  }
  conv.messages.push(msg);
  if (conv.messages.length > MAX_MSGS) {
    // Drop oldest non-system messages until under cap. We always
    // keep the first user message because the title is derived
    // from it.
    while (conv.messages.length > MAX_MSGS) {
      const dropIdx = conv.messages.findIndex(
        (m) => !(m.role === 'user' && m === conv.messages[0]),
      );
      if (dropIdx === -1) {
        conv.messages.shift();
      } else {
        conv.messages.splice(dropIdx, 1);
      }
    }
  }
  conv.updatedAt = Date.now();
  return conv;
}

// V43: pick a 1-line title from the first user message.
function deriveTitle(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && m.text);
  if (!firstUser) {
    return 'New conversation';
  }
  const t = String(firstUser.text).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '...' : t;
}

// V43: create a new conversation, persist, return it.
function createConversation() {
  const conv = {
    id: newId(),
    title: 'New conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  const all = loadConversations();
  all.unshift(conv);
  if (all.length > MAX_CONVS) {
    all.length = MAX_CONVS;
  }
  saveConversations(all);
  setActiveId(conv.id);
  return conv;
}

// V43: delete a conversation by id. Returns the new list.
function deleteConversation(id) {
  const all = loadConversations().filter((c) => c.id !== id);
  saveConversations(all);
  if (getActiveId() === id) {
    setActiveId(all[0] ? all[0].id : null);
  }
  return all;
}

// V43: find a conversation by id, or null.
function getConversation(id) {
  if (!id) {
    return null;
  }
  return loadConversations().find((c) => c.id === id) || null;
}

// V43: persist a full conversation object.
function putConversation(conv) {
  const all = loadConversations();
  const idx = all.findIndex((c) => c.id === conv.id);
  conv.updatedAt = Date.now();
  if (idx === -1) {
    all.unshift(conv);
  } else {
    all[idx] = conv;
  }
  if (all.length > MAX_CONVS) {
    all.length = MAX_CONVS;
  }
  saveConversations(all);
}

// V43: render a conversation as a downloadable markdown file.
function conversationToMarkdown(conv) {
  if (!conv) {
    return '';
  }
  const lines = [];
  lines.push('# ' + (conv.title || 'Untitled'));
  lines.push('');
  lines.push('*Exported from Darwin on ' + new Date().toISOString() + '*');
  lines.push('');
  for (const m of conv.messages || []) {
    if (m.role === 'system' || m.role === 'error') {
      continue;
    }
    const who = m.role === 'user' ? 'You' : 'Darwin';
    lines.push('**' + who + ':**');
    lines.push('');
    lines.push(String(m.text || ''));
    lines.push('');
  }
  return lines.join('\n');
}

// V43: trigger a browser download for the given text content.
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
