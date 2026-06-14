import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContext, _internal } from '../../core/context-loader.js';

const { _extractString, _historyToContext, DEFAULT_IDENTITY, DEFAULT_OPTS } = _internal;

test('ContextLoader: empty memory + empty history returns identity only', async () => {
  const { systemMessages, meta } = await loadContext({ memory: null, historyMessages: [] });
  assert.equal(systemMessages.length, 1);
  assert.equal(systemMessages[0].role, 'system');
  assert.equal(systemMessages[0].content, DEFAULT_IDENTITY);
  assert.deepEqual(meta.layers, ['identity']);
});

test('ContextLoader: includes identity by default', async () => {
  const { meta } = await loadContext({});
  assert.ok(meta.layers.includes('identity'));
});

test('ContextLoader: identity layer can be disabled', async () => {
  const { systemMessages, meta } = await loadContext({ config: { includeIdentity: false } });
  assert.equal(systemMessages.length, 0);
  assert.deepEqual(meta.layers, []);
});

test('ContextLoader: custom identity text overrides default', async () => {
  const custom = '我是测试用的 identity';
  const { systemMessages } = await loadContext({ config: { identityText: custom } });
  assert.equal(systemMessages[0].content, custom);
});

test('ContextLoader: personality layer reads from memory', async () => {
  const fakeMemory = {
    async get(key) {
      if (key === 'darwin-personality') {
        return '你是中文 AI 助手, 简洁.';
      }
      return null;
    },
    async list() {
      return [];
    },
  };
  const { systemMessages, meta } = await loadContext({ memory: fakeMemory, historyMessages: [] });
  assert.equal(systemMessages.length, 2);
  assert.equal(systemMessages[0].content, DEFAULT_IDENTITY);
  assert.equal(systemMessages[1].content, '你是中文 AI 助手, 简洁.');
  assert.deepEqual(meta.layers, ['identity', 'personality']);
});

test('ContextLoader: personality accepts {content: string} shape', async () => {
  const fakeMemory = {
    async get(key) {
      if (key === 'darwin-personality') {
        return { content: '  你是友好的助手  ' };
      }
      return null;
    },
    async list() {
      return [];
    },
  };
  const { systemMessages } = await loadContext({ memory: fakeMemory });
  assert.equal(systemMessages[1].content, '  你是友好的助手  '); // raw, no trim — kept verbatim
});

test('ContextLoader: missing personality key is silently skipped', async () => {
  const fakeMemory = {
    async get() {
      return null;
    },
    async list() {
      return [];
    },
  };
  const { systemMessages, meta } = await loadContext({ memory: fakeMemory });
  assert.equal(systemMessages.length, 1); // identity only
  assert.deepEqual(meta.layers, ['identity']);
});

test('ContextLoader: learnings aggregates user-* keys', async () => {
  const store = new Map([
    ['user-language', '中文 (默认)'],
    ['user-style', '简洁, ≤3 选项'],
  ]);
  const fakeMemory = {
    async get(key) {
      return store.get(key) || null;
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
  const { systemMessages, meta } = await loadContext({ memory: fakeMemory });
  const learningsBlock = systemMessages.find((m) => m.content.includes('已知偏好'));
  assert.ok(learningsBlock, 'expected learnings block');
  assert.ok(learningsBlock.content.includes('user-language: 中文'));
  assert.ok(learningsBlock.content.includes('user-style: 简洁'));
  assert.deepEqual(meta.layers, ['identity', 'learnings']);
  assert.equal(meta.counts.learnings, 2);
});

test('ContextLoader: empty learnings store skips the layer', async () => {
  const fakeMemory = {
    async get() {
      return null;
    },
    async list() {
      return [];
    },
  };
  const { meta } = await loadContext({ memory: fakeMemory });
  assert.equal(meta.layers.includes('learnings'), false);
});

test('ContextLoader: learnings limit caps at LEARNINGS_MAX (20)', async () => {
  const store = new Map();
  for (let i = 0; i < 30; i++) {
    store.set(`user-pref-${i}`, `value-${i}`);
  }
  const fakeMemory = {
    async get(key) {
      return store.get(key) || null;
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
  const { meta } = await loadContext({ memory: fakeMemory });
  assert.equal(meta.counts.learnings, 20);
});

test('ContextLoader: history layer formats last N turns', async () => {
  const history = [
    { role: 'user', content: '第一条问题' },
    { role: 'assistant', content: '第一条回答' },
    { role: 'user', content: '第二条问题' },
  ];
  const { systemMessages, meta } = await loadContext({ historyMessages: history });
  const historyBlock = systemMessages.find((m) => m.content.includes('对话历史'));
  assert.ok(historyBlock.content.includes('用户: 第一条问题'));
  assert.ok(historyBlock.content.includes('你: 第一条回答'));
  assert.ok(historyBlock.content.includes('用户: 第二条问题'));
  assert.equal(meta.counts.history, 3);
});

test('ContextLoader: history truncates to historyLimit', async () => {
  const history = [];
  for (let i = 0; i < 25; i++) {
    history.push({ role: 'user', content: `msg-${i}` });
  }
  const { systemMessages, meta } = await loadContext({
    historyMessages: history,
    config: { historyLimit: 5 },
  });
  const historyBlock = systemMessages.find((m) => m.content.includes('对话历史'));
  assert.ok(historyBlock);
  assert.ok(historyBlock.content.includes('msg-24'));
  assert.equal(historyBlock.content.includes('msg-19'), false);
  assert.equal(meta.counts.history, 5);
});

test('ContextLoader: history char cap truncates per turn', async () => {
  const longContent = 'a'.repeat(500);
  const history = [{ role: 'user', content: longContent }];
  const { systemMessages } = await loadContext({
    historyMessages: history,
    config: { historyCharCap: 50 },
  });
  const historyBlock = systemMessages.find((m) => m.content.includes('对话历史'));
  assert.ok(historyBlock.content.includes('a'.repeat(50)));
  assert.equal(historyBlock.content.includes('a'.repeat(51)), false);
});

test('ContextLoader: empty history skips the layer', async () => {
  const { meta } = await loadContext({ historyMessages: [] });
  assert.equal(meta.layers.includes('history'), false);
  assert.equal(meta.counts.history, 0);
});

test('ContextLoader: all 4 layers in correct order (identity → personality → learnings → history)', async () => {
  const store = new Map([
    ['darwin-personality', '你是 X'],
    ['user-lang', '中文'],
  ]);
  const fakeMemory = {
    async get(key) {
      return store.get(key) || null;
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
  const history = [{ role: 'user', content: 'hi' }];
  const { systemMessages, meta } = await loadContext({
    memory: fakeMemory,
    historyMessages: history,
  });
  assert.equal(systemMessages.length, 4);
  assert.deepEqual(meta.layers, ['identity', 'personality', 'learnings', 'history']);
  assert.ok(systemMessages[0].content.includes('Darwin'));
  assert.equal(systemMessages[1].content, '你是 X');
  assert.ok(systemMessages[2].content.includes('user-lang'));
  assert.ok(systemMessages[3].content.includes('对话历史'));
});

test('ContextLoader: each layer independently toggleable', async () => {
  const fakeMemory = {
    async get(key) {
      if (key === 'darwin-personality') {
        return 'personality text';
      }
      if (key === 'user-x') {
        return 'learning x';
      }
      return null;
    },
    async list(prefix) {
      return prefix === 'user-' ? ['user-x'] : [];
    },
  };
  const history = [{ role: 'user', content: 'h' }];
  const { systemMessages, meta } = await loadContext({
    memory: fakeMemory,
    historyMessages: history,
    config: { includeIdentity: false, includePersonality: false },
  });
  assert.equal(systemMessages.length, 2);
  assert.deepEqual(meta.layers, ['learnings', 'history']);
});

test('ContextLoader: malformed personality value skipped (not throw)', async () => {
  const fakeMemory = {
    async get(key) {
      if (key === 'darwin-personality') {
        return { no_content_field: true };
      }
      return null;
    },
    async list() {
      return [];
    },
  };
  const { meta } = await loadContext({ memory: fakeMemory });
  assert.equal(meta.layers.includes('personality'), false);
});

test('ContextLoader: memory.list throws → learnings layer skipped, no crash', async () => {
  const fakeMemory = {
    async get() {
      return null;
    },
    async list() {
      throw new Error('backend down');
    },
  };
  const { systemMessages, meta } = await loadContext({ memory: fakeMemory });
  assert.equal(meta.layers.includes('learnings'), false);
  assert.equal(systemMessages.length, 1); // identity only
});

test('ContextLoader: history with mixed content types handled', async () => {
  const history = [
    { role: 'user', content: 'normal string' },
    { role: 'assistant', content: '' },
    { role: 'user', content: null },
  ];
  const { systemMessages, meta } = await loadContext({ historyMessages: history });
  assert.equal(meta.counts.history, 3); // counted, even if some are empty
  const historyBlock = systemMessages.find((m) => m.content.includes('对话历史'));
  assert.ok(historyBlock);
});

test('ContextLoader: DEFAULT_OPTS exposes all tunables', () => {
  assert.equal(typeof DEFAULT_OPTS.includeIdentity, 'boolean');
  assert.equal(typeof DEFAULT_OPTS.includePersonality, 'boolean');
  assert.equal(typeof DEFAULT_OPTS.includeLearnings, 'boolean');
  assert.equal(typeof DEFAULT_OPTS.includeHistory, 'boolean');
  assert.equal(typeof DEFAULT_OPTS.historyLimit, 'number');
  assert.equal(typeof DEFAULT_OPTS.historyCharCap, 'number');
  assert.equal(typeof DEFAULT_OPTS.identityText, 'string');
});

test('ContextLoader: _extractString handles all shapes', () => {
  assert.equal(_extractString('hello'), 'hello');
  assert.equal(_extractString('  hi  '), '  hi  ');
  assert.equal(_extractString({ content: 'obj' }), 'obj');
  assert.equal(_extractString({ content: '  obj  ' }), '  obj  ');
  assert.equal(_extractString(null), null);
  assert.equal(_extractString(undefined), null);
  assert.equal(_extractString(42), null);
  assert.equal(_extractString({}), null);
  assert.equal(_extractString({ content: '' }), null);
  assert.equal(_extractString({ content: 123 }), null);
});

test('ContextLoader: _historyToContext returns null for empty', () => {
  assert.equal(_historyToContext([], { historyLimit: 10, historyCharCap: 100 }), null);
  assert.equal(_historyToContext(null, { historyLimit: 10, historyCharCap: 100 }), null);
  assert.equal(_historyToContext(undefined, { historyLimit: 10, historyCharCap: 100 }), null);
});

test('ContextLoader: end-to-end 5-layer integration with realistic shapes', async () => {
  // Simulates a REPL that has prior history + a user-edited personality + learnings
  const store = new Map([
    ['darwin-personality', '你是中文 AI 助手'],
    ['user-language', '中文'],
    ['user-timezone', 'Asia/Shanghai'],
    ['user-emoji', 'prefer ✅ over ❌'],
  ]);
  const fakeMemory = {
    async get(key) {
      return store.get(key) || null;
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
  const history = [
    { role: 'user', content: '帮我写个 Python 函数' },
    { role: 'assistant', content: '好的, 这是...' },
    { role: 'user', content: '改成 Rust 版本' },
  ];
  const { systemMessages, meta } = await loadContext({
    memory: fakeMemory,
    historyMessages: history,
  });
  assert.equal(systemMessages.length, 4);
  assert.equal(meta.counts.history, 3);
  assert.equal(meta.counts.learnings, 3);
  // All 3 learnings present
  assert.ok(systemMessages[2].content.includes('中文'));
  assert.ok(systemMessages[2].content.includes('Asia/Shanghai'));
  assert.ok(systemMessages[2].content.includes('✅'));
});

// =============================================================================
// L6 — SKILL trigger injection (PR-23)
// =============================================================================

import { createRegistry } from '../../core/skill-registry.js';

function makeSkillRegistry() {
  const reg = createRegistry();
  reg.set('weather', {
    name: 'weather',
    triggers: ['天气', 'weather'],
    systemPromptHint: '调用 weather tool 查询实时数据.',
  });
  reg.set('reminder', {
    name: 'reminder',
    triggers: ['提醒', 'remind'],
    systemPromptHint: '调用 reminder tool 设置定时任务.',
  });
  reg.set('translate', {
    name: 'translate',
    triggers: ['翻译', 'translate'],
    systemPromptHint: '调用 translate tool 做多语言翻译.',
  });
  reg.set('empty-hint', {
    name: 'empty-hint',
    triggers: ['empty'],
    systemPromptHint: '',
  });
  return reg;
}

test('L6: currentTurn=null → meta.layers does NOT include skills (backward compat)', async () => {
  const reg = makeSkillRegistry();
  const { systemMessages, meta } = await loadContext({
    historyMessages: [],
    skillRegistry: reg,
    currentTurn: null,
  });
  assert.equal(meta.layers.includes('skills'), false);
  assert.equal(meta.counts.skills, undefined);
  // Backward compat: same as no-skill case
  assert.equal(systemMessages.length, 1); // identity only
});

test('L6: skillRegistry=null → L6 silently skipped, L1-L5 unchanged', async () => {
  const { systemMessages, meta } = await loadContext({
    memory: null,
    historyMessages: [{ role: 'user', content: 'hi' }],
    skillRegistry: null,
    currentTurn: { text: '北京天气怎么样' },
  });
  assert.equal(meta.layers.includes('skills'), false);
  assert.equal(meta.counts.skills, undefined);
  // L1 + L4 still present
  assert.deepEqual(meta.layers, ['identity', 'history']);
  assert.equal(systemMessages.length, 2);
});

test('L6: trigger word matched → injects systemPromptHint for that skill', async () => {
  const reg = makeSkillRegistry();
  const { systemMessages, meta } = await loadContext({
    historyMessages: [],
    skillRegistry: reg,
    currentTurn: { text: '查一下明天北京天气' },
  });
  assert.ok(meta.layers.includes('skills'));
  assert.equal(meta.counts.skills, 1);
  const skillBlock = systemMessages.find((m) => m.content.includes('触发的可用技能'));
  assert.ok(skillBlock);
  assert.ok(skillBlock.content.includes('[weather]'));
  assert.ok(skillBlock.content.includes('调用 weather tool'));
  assert.ok(skillBlock.content.includes('"天气"'));
});

test('L6: matched 3 skills with skillTriggerMax=2 → only first 2 injected', async () => {
  const reg = makeSkillRegistry();
  const { systemMessages, meta } = await loadContext({
    historyMessages: [],
    skillRegistry: reg,
    currentTurn: { text: '明天北京天气怎么样, 顺便提醒我开会, 再翻译一下邮件' },
    config: { skillTriggerMax: 2 },
  });
  assert.equal(meta.counts.skills, 2);
  const skillBlock = systemMessages.find((m) => m.content.includes('触发的可用技能'));
  assert.ok(skillBlock);
  // First two by insertion order: weather, reminder
  assert.ok(skillBlock.content.includes('[weather]'));
  assert.ok(skillBlock.content.includes('[reminder]'));
  // Third (translate) must be truncated out
  assert.equal(skillBlock.content.includes('[translate]'), false);
});

test('L6: matched skill with empty systemPromptHint → that skill skipped, not counted', async () => {
  // Build a registry where the only matching skill has empty hint
  const reg = createRegistry();
  reg.set('empty-hint', {
    name: 'empty-hint',
    triggers: ['magic'],
    systemPromptHint: '',
  });
  reg.set('real', {
    name: 'real',
    triggers: ['magic'],
    systemPromptHint: 'Real hint.',
  });
  const { systemMessages, meta } = await loadContext({
    historyMessages: [],
    skillRegistry: reg,
    currentTurn: { text: 'do the magic trick' },
  });
  // Only "real" should inject; "empty-hint" silently skipped
  assert.equal(meta.counts.skills, 1);
  const skillBlock = systemMessages.find((m) => m.content.includes('触发的可用技能'));
  assert.ok(skillBlock);
  assert.ok(skillBlock.content.includes('[real]'));
  assert.equal(skillBlock.content.includes('[empty-hint]'), false);
});

test('L6: L1-L5 order unchanged when L6 is active (snapshot)', async () => {
  const store = new Map([
    ['darwin-personality', '你是 X'],
    ['user-lang', '中文'],
  ]);
  const fakeMemory = {
    async get(key) {
      return store.get(key) || null;
    },
    async list(prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
  const reg = makeSkillRegistry();
  const history = [{ role: 'user', content: 'hi' }];
  const { systemMessages, meta } = await loadContext({
    memory: fakeMemory,
    historyMessages: history,
    skillRegistry: reg,
    currentTurn: { text: '明天天气' },
  });
  // Expected order: identity, personality, learnings, history, skills
  assert.deepEqual(meta.layers, ['identity', 'personality', 'learnings', 'history', 'skills']);
  assert.equal(systemMessages.length, 5);
  // Snapshot first 4 contents — must be exactly the L1-L4 blocks
  assert.ok(systemMessages[0].content.includes('Darwin'));
  assert.equal(systemMessages[1].content, '你是 X');
  assert.ok(systemMessages[2].content.includes('user-lang'));
  assert.ok(systemMessages[3].content.includes('对话历史'));
  // L6 is last
  assert.ok(systemMessages[4].content.includes('触发的可用技能'));
});

test('L6: trigger matching is case-insensitive ("WEATHER" hits trigger "weather")', async () => {
  const reg = createRegistry();
  reg.set('weather', {
    name: 'weather',
    triggers: ['weather'],
    systemPromptHint: 'Weather hint here.',
  });
  const { systemMessages, meta } = await loadContext({
    historyMessages: [],
    skillRegistry: reg,
    currentTurn: { text: 'what is the WEATHER in Tokyo?' },
  });
  assert.equal(meta.counts.skills, 1);
  const skillBlock = systemMessages.find((m) => m.content.includes('触发的可用技能'));
  assert.ok(skillBlock);
  assert.ok(skillBlock.content.includes('[weather]'));
  assert.ok(skillBlock.content.includes('"weather"')); // triggerHit preserves original case
});
