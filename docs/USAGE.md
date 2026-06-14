# Darwin v2 操作说明

让 Darwin 跑起来 **3 步走** (5 分钟内).

## 1. 准备

```bash
# 拉代码
git clone <darwin-repo> ~/darwin
cd ~/darwin

# 装依赖 (0 外部 dep, 只有 dev 工具)
npm install

# 给 CLI 加执行权限
chmod +x bin/darwin

# 验证
npm test          # 期望 332/332 pass
node bin/darwin help  # 期望看到 8 个 sub-commands
```

## 2. 配置 LLM (一次性)

Darwin 默认找 `~/.darwin/` 下的配置. **3 步**:

```bash
# A. 写非敏感配置 + 写 .env (交互式问答)
node bin/darwin config add provider-anthropic
# 依次问: base_url / api_key / default_model / version
# 回车 = 用默认值

# B. 看看写进去啥 (api_key 自动脱敏)
node bin/darwin config show
```

**支持的 provider**:

| 模块                 | 协议           | 覆盖                                             |
| -------------------- | -------------- | ------------------------------------------------ |
| `provider-anthropic` | Anthropic 原生 | Claude 全系                                      |
| `provider-openai`    | OpenAI 兼容    | OpenAI / DeepSeek / Qwen / GLM / Moonshot / 一堆 |

**配置文件**:

- `~/.darwin/provider-anthropic.yaml` — base_url / default_model / version
- `~/.darwin/.env` — `ANTHROPIC_API_KEY=sk-...` (真凭据, 不进 git)

## 3. 跑

### `darwin chat "..."` — 单次对话

```bash
node bin/darwin chat "你好, 介绍下你自己"
# 🤖 Using anthropic
#
# 你好! 我是 Darwin, 一个自我进化的数字生命体...
```

### `darwin repl` — 持续聊天

```bash
node bin/darwin repl
# 🤖 Darwin REPL — using anthropic
#    (Ctrl+D or "exit" to quit, "clear" to wipe history)
#
# 📜 Restored 6 prior messages   ← 重启会续上次的上下文
#
# you> 你好
# anthropic> 你好! ...
#
# you> 我刚才问过你啥
# anthropic> 你刚才问 "你好" ...
#
# you> clear        ← 清空历史
# 🗑 history cleared
#
# you> exit        ← 退出
# 👋 bye
```

**上下文持久化到 memory** (`~/.darwin/memory/darwin-repl-history.json`), 重启可续.

### `darwin config ...` — 配置管理

```bash
# 添加 (交互式)
node bin/darwin config add provider-anthropic
node bin/darwin config add provider-openai

# 查看 (脱敏)
node bin/darwin config show
# [provider-anthropic]
#   base_url: "https://api.anthropic.com"
#   api_key: ***REDACTED***
#   default_model: "claude-sonnet-4-5"
#   version: "2023-06-01"
# [provider-openai]
#   (not configured)
# [memory-default]
#   (not configured)
# [darwin-runtime]
#   (not configured)
```

### `darwin plugin ...` — 加载 plugin

```bash
# 添加 (自动 load + init + enable)
node bin/darwin plugin add ./plugin/__example__/logger.js
# ✓ Loaded: ./plugin/__example__/logger.js → logger
# ✓ Initialized: logger
# ✓ Enabled: logger (ready)

# 列出
node bin/darwin plugin list
# - logger v1.0.0 [log]
```

**写自己的 plugin**: 创建一个文件, default export 一个对象, 至少含 `name` 字段. 详细看 `plugin/__example__/logger.js` (40 行, 5 阶段 lifecycle 注释).

### `darwin memory ...` — 读写 memory

```bash
# 写 (string-only MVP)
node bin/darwin memory set greeting "hello darwin"
# ✓ greeting = hello darwin
#   (filesystem backend: ~/.darwin/memory/)

# 读
node bin/darwin memory show greeting
# hello darwin

# 给 Darwin 一个身份 (system prompt, 每次 chat/repl 自动用)
node bin/darwin memory set darwin-personality "你是 Darwin, 一个自我进化的数字生命体, 跟用户用中文简洁沟通"
# → 下次 chat 立刻 LLM 改口说 "我是 Darwin"
# → REPL 每次 turn 重新读, 改了立即生效不用重启
```

**默认 backend**: filesystem, 路径 `~/.darwin/memory/<key>.json`. 写 JSON 留 W2 (`--json` flag).

## 完整命令列表

```
darwin chat "..."              单次对话
darwin repl                    持续聊天 (上下文持久化)
darwin config add <module>     交互式添加配置
darwin config show             列出配置 (脱敏)
darwin plugin add <path>       加载 plugin
darwin plugin list             列出已加载
darwin memory show <key>       读 memory
darwin memory set <key> <val>  写 memory (string)
darwin help                    帮助
```

## 配置文件位置

```
~/.darwin/
├── darwin.yaml.example         (代码层模板, 不存在, 看 repo config/)
├── provider-anthropic.yaml     (用户层: 非敏感配置)
├── provider-openai.yaml        (用户层: 非敏感配置)
├── memory-default.yaml         (用户层: memory 配置)
├── darwin-runtime.yaml         (用户层: runtime 配置)
├── .env                        (凭据层: ANTHROPIC_API_KEY=...)
└── memory/                     (filesystem backend 数据)
    ├── darwin-repl-history.json
    └── <your-keys>.json
```

**3 层配置** (Darwin v2 核心设计):

1. **代码层** `config/<module>.yaml` (in repo, committed) — 默认值
2. **用户层** `~/.darwin/<module>.yaml` (not in git) — 用户覆盖
3. **凭据层** `~/.darwin/.env` (not in git) — 真 key

合并顺序: 凭据 > 用户 > 代码 (后者覆盖前者).

## 常见问题

### Q: `⚠ No provider configured. Run: darwin config add provider-anthropic`

**原因**: 没跑 `config add` 或没填 api_key.  
**解决**: 跑 `node bin/darwin config add provider-anthropic` 重新填.

### Q: `✗ chat failed: 401 Unauthorized`

**原因**: API key 错或没设.  
**解决**:

1. `node bin/darwin config show` 看 api_key 是不是 `***REDACTED***` (说明填了)
2. 打开 `~/.darwin/.env` 看 key 对不对
3. 重新跑 `config add` 覆盖

### Q: `Error: Cannot find module 'foo'`

**原因**: 漏了 `npm install`.  
**解决**: `cd ~/darwin && npm install`.

### Q: `EACCES: permission denied, mkdir '.darwin'`

**原因**: HOME 不可写.  
**解决**: `chmod +w ~` 或换 HOME (`export HOME=/tmp/foo`).

### Q: 怎么换 LLM (从 Claude 切到 DeepSeek / MiniMax)?

```bash
# 1. 加 openai 兼容 provider
node bin/darwin config add provider-openai
# base_url: https://api.deepseek.com/v1   (或 https://api.minimaxi.com/v1, 带 /v1 行业标准)
# api_key: sk-deepseek-... (或 MiniMax 的 key)
# default_model: deepseek-chat   (或 MiniMax-M3)

# 2. 切默认 = 删 anthropic 的 yaml (Darwin 取第一个注册的 provider)
mv ~/.darwin/provider-anthropic.yaml ~/.darwin/provider-anthropic.yaml.bak

# 3. 跑
node bin/darwin chat "你好"
# 🤖 Using openai-compatible   ← 切了
```

> base_url 带不带 `/v1` 都行, Darwin 自动去重. 推荐带 (跟 OpenAI 官方文档一致).

### Q: 怎么写自己的 plugin?

最简例子 (40 行), 看 `plugin/__example__/logger.js`. 5 阶段 lifecycle:

```js
// my-plugin.js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  capabilities: ['log'],
  init({ eventBus }) {
    eventBus.on('provider:call:after', (e) => {
      console.log(`[my-plugin] provider ${e.provider} called`);
    });
  },
  destroy() {},
};
```

跑 `node bin/darwin plugin add ./my-plugin.js` 即可加载.

## 进阶

### 跑测试

```bash
npm test                 # 跑 332 tests
npm run lint             # ESLint
npm run size-check       # 1000 行硬约束检查
npm run verify           # 三合一
npm run test:watch       # watch 模式
npm run test:coverage    # 覆盖率
```

### 调试

```bash
# 看单次调用的事件流
node -e "
import('./bin/lib/_shared.js').then(async ({sharedBootstrap}) => {
  const {bus, registry} = await sharedBootstrap();
  bus.on('provider:call:*', (e, p) => console.log('[event]', p.event, JSON.stringify(e)));
  await registry.list()[0].chat({messages: [{role: 'user', content: 'hi'}]});
});
"
```

### 跟 Darwin v3 衔接

v2 启动期 = 骨架 only. v3 自我进化期 = Darwin 自己改自己. 周边业务 (飞书 / CLI history / 配置文件拆分 / vector memory) **留给 Darwin 自实现**, 不在 v2 范围.

PR 20+ 候选: vector memory / per-module example yaml / cli history / darwin init.

## 调研参考

| 文档                                                                       | 用途                                                                            | 状态                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| [OPENCLAW_PROMPT_REFERENCE.md](./OPENCLAW_PROMPT_REFERENCE.md)             | OpenClaw prompt + tool 调研（PR-A FINAL，给 darwin-architect 对齐 PR-23/24/25） | ✅ v1.0 (2026-06-14, 1018 行) |
| [OPENCLAW_PROMPT_REFERENCE_DRAFT.md](./OPENCLAW_PROMPT_REFERENCE_DRAFT.md) | PM 种子稿（v0.1）                                                               | 📜 历史                       |
| [ANTI_PATTERNS.md](./ANTI_PATTERNS.md)                                     | v2 反模式清单                                                                   | ✅ v1.0                       |
| [USAGE.md](./USAGE.md)                                                     | v2 操作说明                                                                     | ✅ v1.0                       |

## 反馈

跑挂了先看 `npm test` 通不通, 再看 `~/.darwin/` 权限. 真解决不了, 跑 `node bin/darwin --version` 看版本 (W2 加) + 提 issue.
