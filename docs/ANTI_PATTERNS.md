# Darwin v2 ANTI_PATTERNS（反模式清单）

> **v2 启动日 D-0 第一天要建在 `darwin_v2/docs/ANTI_PATTERNS.md` 的文件**。
> v1 教训 1:1 复刻——**绝不重蹈**。
> 团队培训用 + PR review 监督用 + 监督机制对照用。

---

## 怎么用这份文档

1. **PR review 时**：reviewer 看到任一反模式 → reject
2. **新 subagent 上岗时**：必读，作为 onboarding 第一课
3. **每周末 PM 复盘时**：哪个规则被绕过了、为什么
4. **季度回看时**：哪些反模式已不反了（v3 演化），哪些仍顽固

---

## 类别 A：模块拆分反模式

### A-1. 反模式：按行数拆模块

❌ **反例**：
```js
// DarwinCore.js 2621 行 → 拆 a.js 800 行 + b.js 900 行 + c.js 921 行
// 行数破了，但 3 个文件互相 import 业务函数，依赖照样乱
```

✅ **正确做法**：按"职责"拆
```js
// 按职责拆 7 模块：
// lifecycle:bootstrap / lifecycle:shutdown
// plugin:loader / plugin:registry
// core:container / core:event-bus / core:error-handler
```

**v1 教训**：DarwinCore.js 2621 行 = 7 大职责堆在一起；按行数切 = 假拆。

---

### A-2. 反模式：跨模块直接 import 业务函数

❌ **反例**：
```js
// SelfEvolution.js 里直接 import
const { PluginManager } = require('./PluginManager');
PluginManager.loadPlugin(name);  // 直接函数调用
```

✅ **正确做法**：走 EventBus
```js
// SelfEvolution.js 里
this.eventBus.emit('plugin:load:request', { name });
// PluginManager 订阅
eventBus.on('plugin:load:request', async ({ name }) => {
  await this.loadPlugin(name);
});
```

**v1 教训**：改 PluginManager 函数签名 → SelfEvolution 编译错 → 模块间紧耦合。

---

### A-3. 反模式：Provider 同一份写 2 遍

❌ **反例**：
```js
// plugins/llm/providers/minimax.js  (600 行) ← 一份实现
// llm/providers/minimax.js          (667 行) ← 同一 provider 又写一遍
```

✅ **正确做法**：Provider 单文件单路径
```js
// llm/providers/minimax.js  (唯一文件)
// plugins/llm/index.js 里 require 它一次
```

**v1 教训**：v0.25 飞书 tool call bug = 双路径里其中一条忘了修；6 个坑修了 3 个就发布。

---

### A-4. 反模式：Config 硬读 process.env

❌ **反例**：
```js
// plugins/adapter-feishu/index.js L86
const appId = process.env.FEISHU_APP_ID || '';
// env 没注入 → 展开空字符串 → throw
```

✅ **正确做法**：ConfigResolver 唯一入口
```js
const { ConfigResolver } = require('./core/ConfigResolver');
const cfg = ConfigResolver.get('adapter-feishu');
const appId = cfg.app_id;  // 含 fallback / 错误提示
```

**v1 教训**：4 个 plugin 硬读 env，env 没注入就静默失败。

---

### A-5. 反模式：HookManager 和 EventBus 共存

❌ **反例**：
```js
// core/HookManager.js 516 行 ← 老的 hook 系统
// core/EventBus.js ← 新的事件总线
// 两套并存，调用方混乱
```

✅ **正确做法**：EventBus 替代 HookManager
```js
// v2 不再新建 HookManager，统一走 EventBus
// HookManager 在 v2 标记 deprecated，v3 删除
```

**v1 教训**：HookManager 516 行，是 EventBus v0.8 之前的遗留，新旧并存。

---

## 类别 B：Hygiene 反模式

### B-1. 反模式：文档承诺 ignore ≠ 实际 ignore

❌ **反例**：
```yaml
# docs/configuration.md 写：
# "llm_config.yaml 不会被 git track"
# 但 .gitignore 实际只 ignore 了 llm_config.local.yaml
# 开发者按文档 cp 真值 → commit → 真值进 git history
```

✅ **正确做法**：3 件套强制
```
1. 文档承诺 ignore 的 → .gitignore 必配真规则（CI 验证）
2. 真值 backup 路径明确（默认 ~/.darwin/.env）
3. pre-commit hook 拦截任何含 sk-/api_key/ 的文件
```

**v1 教训**：v0.23 hygiene R-1 = 3 commit 含真值在 git history，其中 `5fbd409` 含真 `sk-cp-wvWf-...` API key。**P0-1 待 `git filter-repo`**。

---

### B-2. 反模式：散点活不分类就接

❌ **反例**：
```text
飞书 bug 紧急修（应该是 P0 真紧急）
↓
R-2 anchor 修复（其实是 P2 不紧急）
↓
Health "critical" 噪音降噪（其实是 P2）
↓
W-1 troubleshooting 链接（其实是 P2）
↓
4 天过去了，W2 准备期 = 0
```

✅ **正确做法**：散点活分类法
| 优先级 | 处理 |
|---|---|
| P0 真紧急 | 立刻做 |
| P1 重要不紧急 | 攒到下个 sprint |
| P2 不重要不紧急 | 砍掉或随 P1 一起 |
| P3 锦上添花 | 永远搁置 |

**v1 教训**：4 天修 6 件散点活，主线 0 推进。

---

### B-3. 反模式：working tree 脏文件未清理

❌ **反例**：
```bash
$ git status --short
?? .openclaw/
?? AGENTS.md
?? AGENTS.md.bak.20260603-092817
?? HEARTBEAT.md
?? IDENTITY.md
?? IDENTITY.md.bak.20260603-092817
?? SOUL.md
?? TOOLS.md
?? USER.md
?? darwin_core/llm_config.yaml.gitkeep
?? darwin_core/memory/
?? memory/
# 14 个未跟踪文件，混进主仓库会污染
```

✅ **正确做法**：.gitignore 完整 + workspace 元数据分离
```
# .gitignore 必加
.openclaw/
*.bak
AGENTS.md
IDENTITY.md
SOUL.md
TOOLS.md
USER.md
HEARTBEAT.md
memory/
*.local
*.env
config.*.local
```

**v1 教训**：14 个未跟踪文件散落，部分是 OpenClaw workspace 自己的元数据，不该进 darwin 仓库。

---

## 类别 C：派活反模式

### C-1. 反模式：派活 prompt 只给目标不给验收

❌ **反例**：
```text
"实现 typing reaction"  ← subagent 决策一切，刚及格
```

✅ **正确做法**：prompt 4 件套
```text
① 目标（含验收）：实现飞书 typing reaction；3 个 emoji_type 选 1；8 jest 单测 + 7 e2e assertion 全过
② 背景：darwin_core/plugins/adapter-feishu/index.js L86-90；用 OpenAI 协议
③ 严格禁止：❌ 改 adapter-feishu 其他逻辑 / ❌ 加新依赖 / ❌ 改 CLI
④ 回执（4 件必带）：完成情况 + git diff --stat + 测试结果 + commit SHA
```

**v1 教训**：及格 prompt vs 超预期 prompt 差异 = 8 单测 vs 0 单测。

---

### C-2. 反模式：信 subagent 自报 = 通知说完成 = 默认完成

❌ **反例**：
```text
subagent: "完成了，跑了测试，commit abc123"
PM: 看了通知 → 标 done → 合 master
实际：commit abc123 不存在 / 文件 size = 0 / 测试只跑 1 个
```

✅ **正确做法**：PM 4 步硬验
```bash
# 1. git log 看 commit（必带 commit SHA）
git log --oneline -3

# 2. git show 看 diff
git show --stat <commit_sha>

# 3. 文件落盘（mtime + size > 0）
ls -la /path/to/deliverable

# 4. 端到端验证（curl / 测试套件 / 日志）
curl -X POST /chat -d '{"message":"1+1=？","userId":"x"}'
```

**v1 教训**：4 次 OpenClaw timeout 通知 → 实际 4 次都成功（**"通知说 timeout ≠ 任务挂"**）；coder 进程退出后**没 commit、没 3 行回报** → 默认没完成。

---

### C-3. 反模式：派活没带 backup 5 件套就改凭据

❌ **反例**：
```text
派活 prompt: "把 FEISHU_APP_ID 替换成 ${FEISHU_APP_ID} 占位符"
subagent: 直接改了 → 整个飞书通道挂
真值在哪？→ 忘了备份，要找 4 小时
```

✅ **正确做法**：派活 5 件套（hygiene 必带）
```
1. 真值 backup 路径明确（默认 ~/.darwin/.env）
2. chmod 600 ~/.darwin/.env
3. .gitignore 包含 .env 模式
4. 顺序：backup → commit backup → 改占位符 → commit 改占位符
5. 派活 prompt 写明"先 backup 再改"
```

**v1 教训**：2026-06-04 凌晨栽过 2 次，coder 把真凭据替换成占位符时**没把真值备份**。

---

### C-4. 反模式：spawn 不带 session-key 前缀

❌ **反例**：
```bash
openclaw agent --agent darwin-coder --session-key main -m "..."
# 派活落到 main session，污染主上下文
```

✅ **正确做法**：spawn 必须带 session-key 前缀
```bash
openclaw agent --agent darwin-coder --session-key agent:darwin-coder:task-xyz -m "..."
# 派活落到子 session，main 干净
```

**v1 教训**：OpenClaw routing bindings 把派活落到 main session = 主上下文被污染。

---

## 类别 D：Tool Call 协议反模式（v0.25 飞书 bug 教训）

### D-1. 反模式：tool_calls 格式错（每 toolCall 单独 push）

❌ **反例**：
```js
// 旧代码：每个 toolCall 单独 push assistant 消息（错格式）
for (const tc of toolCalls) {
  messages.push({ role: 'assistant', tool_calls: [tc] });  // ← 错
  messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
}
// Round 2 LLM 拿不到完整上下文 → 响应被吞
```

✅ **正确做法**：合成 1 个 assistant + N 个 role:tool
```js
// 新代码：1 个 assistant 消息 + N 个 role:tool 消息
messages.push({ role: 'assistant', tool_calls: toolCalls });
for (let i = 0; i < toolCalls.length; i++) {
  messages.push({ role: 'tool', tool_call_id: toolCalls[i].id, content: results[i] });
}
```

**v1 教训**：OpenAI/MiniMax 协议硬要求 → 99% 教程只教 happy path，0% 教 Round 2 怎么接。

---

### D-2. 反模式：无 MAX_TOOL_ROUNDS 限制

❌ **反例**：
```js
// 工具循环无上限
while (true) {
  const resp = await llm.chat(messages);
  if (resp.tool_calls) {
    // 永远跑下去，吃光上下文
  }
}
```

✅ **正确做法**：硬上限 5 轮
```js
const MAX_TOOL_ROUNDS = 5;
for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const resp = await llm.chat(messages);
  if (!resp.tool_calls) break;
  // ...
}
```

**v1 教训**：v0.25.1 fix 加了 MAX_TOOL_ROUNDS=5 防死循环吃光上下文。

---

### D-3. 反模式：工具执行无 try/catch

❌ **反例**：
```js
// 一个工具抛错 → 整轮崩
const result = await tool.execute(args);
messages.push({ role: 'tool', content: result });
```

✅ **正确做法**：try/catch + 降级
```js
try {
  const result = await tool.execute(args);
  messages.push({ role: 'tool', content: result });
} catch (err) {
  messages.push({ role: 'tool', content: `Error: ${err.message}` });
  // 不崩，继续
}
```

**v1 教训**：一工具崩整轮崩。

---

## 类别 E：散点活黑洞（PM 节奏反模式）

### E-1. 反模式：把 W2 准备期当 W2 启动期

❌ **反例**：
```text
W2 启动日是 6/9 → "那 6/9 之前不用准备"
实际：6/6-6/8 应该拆任务 / 排依赖 / 收边界
结果：6/9 启动日 = 现拆现排现收 = 节奏全乱
```

✅ **正确做法**：3 天准备期
| 日 | 产出 |
|---|---|
| D-3 | 现状盘点 |
| D-2 | 拆解评估 |
| D-1 | 初稿 |
| D-0 | 启动 |

---

### E-2. 反模式：周报只讲做了什么不讲没做什么

❌ **反例**：
```text
本周完成：飞书 tool call 修 6 处 / hygiene R-1 修复 / v0.23 docs 4628 行
本周没做：W2 准备 = 0 / 3 个超限文件 = 0 进展
```

✅ **正确做法**：周报含"未做" + "为什么"
```text
本周完成：飞书 tool call 修 6 处 / hygiene R-1 / v0.23 docs
本周未做：W2 准备 0 进展
未做原因：散点活黑洞吞噬 PM 注意力 / 没有分类法
下周动作：6/6 拍散点活分类法 + 冻结期协议 / 6/6-6/8 集中做 W2 准备
```

---

## 监督机制

- **PR review**：reviewer 看到任一反模式 → reject
- **CI 自动**：编码规则清单的 7 条硬约束自动检查
- **每周末 PM 复盘**：哪个规则被绕过了、为什么
- **季度回看**：哪些反模式已不反了（v3 演化），哪些仍顽固

---

## ANTI_PATTERNS 总表（速查）

| 类别 | # | 反模式 | v1 教训位置 |
|---|---|---|---|
| A 模块拆分 | A-1 | 按行数拆模块 | retro-03 |
| A | A-2 | 跨模块直接 import 业务函数 | retro-03 |
| A | A-3 | Provider 同一份写 2 遍 | retro-03 |
| A | A-4 | Config 硬读 process.env | retro-02 |
| A | A-5 | HookManager 和 EventBus 共存 | retro-03 |
| B Hygiene | B-1 | 文档承诺 ignore ≠ 实际 ignore | retro-02/03 |
| B | B-2 | 散点活不分类就接 | retro-01 |
| B | B-3 | working tree 脏文件未清理 | retro-01 |
| C 派活 | C-1 | 派活 prompt 只给目标不给验收 | retro-02 |
| C | C-2 | 信 subagent 自报 | retro-02 |
| C | C-3 | 派活没带 backup 5 件套就改凭据 | retro-02 |
| C | C-4 | spawn 不带 session-key 前缀 | retro-02 |
| D Tool Call | D-1 | tool_calls 格式错 | retro-03 |
| D | D-2 | 无 MAX_TOOL_ROUNDS 限制 | retro-03 |
| D | D-3 | 工具执行无 try/catch | retro-03 |
| E PM 节奏 | E-1 | W2 准备期当 W2 启动期 | retro-01 |
| E | E-2 | 周报只讲做了什么不讲没做什么 | retro-01 |

**共 17 条反模式**——v2 启动日 1:1 抄进 `darwin_v2/docs/ANTI_PATTERNS.md`。

---

*2026-06-06，老王（Hermes）记录。v2 启动日 D-0 第一件事：把这份文档 1:1 抄进 `darwin_v2/docs/ANTI_PATTERNS.md`。*
