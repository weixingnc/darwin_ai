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
PluginManager.loadPlugin(name); // 直接函数调用
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
const appId = cfg.app_id; // 含 fallback / 错误提示
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
  messages.push({ role: 'assistant', tool_calls: [tc] }); // ← 错
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

## 类别 F：v2 启动期新教训（PR 1-3 沉淀）

### F-1. 反模式：lint-staged 不分文件类型

❌ **反例**：

```json
"lint-staged": {
  "*.{js,json,md,yaml,yml}": [
    "prettier --write",
    "eslint --fix"
  ]
}
```

→ `package.json` / `package-lock.json` 不是 JS，被 eslint 扫后报 "Parsing error: Unexpected token :"。

✅ **正确做法**：

```json
"lint-staged": {
  "*.js": ["eslint --fix", "prettier --write"],
  "*.{json,md,yaml,yml}": ["prettier --write"]
}
```

**v2 教训**（PR 1 修复）：lint-staged 必须按文件类型分，**JSON / YAML / Markdown 永远不跑 eslint**。

---

### F-2. 反模式：mini-YAML 解析不写嵌套支持

❌ **反例**（v2 启动期 PR 3 早期版本）：

```js
// 只支持顶层 key: value
for (const line of content.split('\n')) {
  const m = line.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
  if (m) result[m[1]] = m[2]; // 嵌套配置 feishu: { app_id, app_secret } 全部 flat 成顶层
}
```

→ provider 配置（`feishu: { app_id, app_secret }`）无法表达，**user deep overrides code** 测试失败。

✅ **正确做法**（v2 PR 3 修复）：v2 启动期手写 "1 层缩进" mini-YAML parser（state machine + parentKey 跟踪）：

```js
// 支持 2 空格缩进 = 1 层嵌套（provider / adapter 配置足够）
if (indent === 0) {
  result[key] = value;
  parentKey = value === '' ? key : null;
} else if (indent === 2 && parentKey) {
  /* push to result[parentKey][key] */
}
```

**v2 教训**：v2 启动期不引 `yaml` 包（避免 devDep 膨胀），但**手写 parser 必须支持 1 层嵌套**——provider / adapter 配置全是嵌套的。**更深嵌套**留 PR 12 引 yaml 包。

---

### F-3. 反模式：测试设计按"理想逻辑"而非"实际业务"

❌ **反例**（v2 PR 3 早期测试）：

```js
test('cred env overrides everything', () => {
  const cfg = resolver.get('demo');
  // 期望 app_id = 'from-cred'
  // 但 yaml 字面量是 'from-user'，cred env key 是 APP_ID
  // → key 不匹配，cred env 实际不覆盖字面量
});
```

→ 期望"cred env 覆盖 yaml 字面量"，但 v2 设计 cred env 是 `${VAR}` 源，**不**直接覆盖字面量。测试逻辑错。

✅ **正确做法**：测试按真实业务写：

```js
test('cred env fills ${VAR} placeholder', () => {
  // yaml: 'app_id: ${APP_ID}'
  // cred env: 'APP_ID=cred-value'
  // 期望: app_id === 'cred-value'
  process.env.APP_ID = 'process-value'; // 验证 cred 优先
  // ...
});
```

**v2 教训**：写测试前**先想清楚 v2 设计的真实语义**——cred env 是 `${VAR}` 源，**不**直接覆盖 yaml 字面量。**测试逻辑 = 设计文档**，写错 = 文档就错。

---

### F-4: PR 500 行硬约束按"git 跟踪行"还是"subagent 自报净 lines"模糊

**v2 启动期 PR 5 教训**（2026-06-06）：

- 单 PR < 500 行硬约束（C-1 派活规则的 budget）
- subagent commit body 写 `total: 499 lines (under 500 budget)`
- 但 `git show --stat` 显示 **502 insertions**（超 2 行 = 0.4% 边界）
- 差额来自：每文件末行换行（git 跟踪 +1/文件，6 文件 = +6 行）+ commit body 内代码块描述（主观统计漏算）
- PM 4 步硬验走 `git show --stat`（客观），与 subagent 自报（主观）冲突

**v2 规则**：

- **500 硬约束 = `git show --stat` 整数行（git 跟踪行）**——客观、可复现
- **0.4% 弹性 = `git stat` ≤ 510 行仍视作合格**
- **不再为 ≤ 5 行偏差退回 subagent**（PM 接手改 2 行的代价比 5 行偏差大）
- 超 510 行 = 退回重做

**理由**：

- subagent 自报（commit body 的"total: 499 lines"）= 主观、易漏算
- git stat = 客观、机器读数
- PM 4 步硬验走 git stat = 唯一权威
- 0.4% 弹性留给 lint disable 注释 + commit body 末行换行差异

**PM 决策模板**：

```
git stat > 510 = 退
git stat ≤ 510 且 ≥ 495 = 接受 + 写 commit body 注明差额
git stat < 495 = 接受（subagent 留了 buffer）
```

---

### F-5: cherry-pick 拆 commit 时漏 rm 文件 → main 状态污染

**v2 启动期 PR 7 教训**（2026-06-06）：

- F-4 触发：PR 7 git stat 736 > 510 弹性上限
- PM 决策：拆 PR 7a (interface + base + 2 test = 409 行) + PR 7b (tool-call + 1 test = 327 行)
- PM 拆 commit 流程（**高危手工操作**）:
  1. `git checkout -b feat/pr7a-protocol-skeleton`
  2. `git cherry-pick 136b869` → 引入 6 文件
  3. `git rm provider/protocol/tool-call.js tests/protocol-tool-call.test.js` → 删 2 文件
  4. `git commit --amend` → PR 7a (4 文件 / 409 行)
  5. `git checkout -b feat/pr7b-tool-call`
  6. `git cherry-pick 136b869` → 引入 6 文件（main 上已存在 interface/base/2 test）
  7. `git rm provider/protocol/interface.js provider/protocol/base.js tests/protocol-interface.test.js tests/protocol-base.test.js` → **误删 4 文件（含 PR 7a 的 2 test）**
  8. `git commit --amend` → PR 7b (2 文件 / 327 行)
  9. `git merge --no-ff` → main 上只剩 tool-call.js + 1 test，**缺 PR 7a 的 2 test 文件**
- **Bug 结果**: main 跑 `npm test` = 126（110 baseline + 16 tool-call），**缺 18 skeleton tests**
- **下游污染**: PR 8 subagent 从 main 拉分支 = 126 tests baseline（不知道 main 应是 144）
- **PM 4 步硬验发现**: 126 ≠ 144, git log 显示 main 历史不连续

**v2 规则**：

- **cherry-pick 拆 commit = 高危操作**，**必须**先列 `git ls-files` 双重核对
- **拆 commit 前**: 写"要保留的文件清单 (KEEP)" + "要删除的文件清单 (DELETE)" + 逐项打勾
- **拆 commit 后 + merge 前**: 在源分支跑 `npm test` 验证 baseline + 保留测试通过
- **merge 后**: 在 main 跑 `npm test` 验证总测试数 = 之前 baseline + PR 增量

**Cherry-pick 拆 commit 决策模板（**必走**）**：

```
step 1: git checkout main
step 2: git checkout -b feat/pr<X>a-<name>
step 3: git cherry-pick <original_commit_sha>
step 4: 写 KEEP 清单 + DELETE 清单（**双重核对, 每个文件手打**）
step 5: git rm <DELETE>     ← 复制粘贴, 不通配符
step 6: git status          ← **人工核对 staged files = KEEP 清单**
step 7: git commit --amend
step 8: npm test            ← **验证 baseline + 保留测试通过**（不通过 = 立刻 abort, 回去改）
step 9: git checkout main && git merge --no-ff
step 10: npm test           ← **验证 main 总测试数 = 之前 baseline + PR 增量**（不通过 = git reset --hard + 重做）
```

**反 anti-pattern**：

- ❌ `git rm *.js` 通配符删（漏文件 / 错文件）
- ❌ cherry-pick 后不 list 立刻 rm
- ❌ merge 前不验证测试 baseline
- ❌ merge 后不在 main 跑 npm test 验证
- ✅ 用 `git diff --name-only <original>..HEAD` 列出 PR 实际改的文件
- ✅ 拆 commit 前**画文件清单图**（KEEP vs DELETE 双向打勾）

**PM 自查清单**（**每次拆 commit 前必走**）:

```
□ 写出 KEEP 清单（每行一个文件路径）
□ 写出 DELETE 清单（每行一个文件路径）
□ KEEP ∪ DELETE = cherry-pick 引入的全部文件（**没有遗漏**）
□ KEEP ∩ DELETE = ∅（**没有重复**）
□ npm test 在 KEEP 后的 working tree 通过
□ merge 后 main npm test 总数 = baseline + PR 增量
```

---

### F-6: PM 操作 git 必走"操作前 4 步自查 + 操作后 3 步验证"反射

**v2 启动期 PR 7/8/9 教训**（2026-06-06）：

3 个重复 bug 的根因都是"PM 缺乏操作前自查反射":

- PR 7: cherry-pick 拆 commit 时漏 rm 文件（F-5 教训，PM 自己又触发）
- PR 8: PM 接管时 `git commit` 跑在了 feat/pr8-protocol-openai 分支上（**不是 main**）
- PR 9: PM 接管时 `git commit` 跑在了 feat/pr9-openai-provider 分支上（**不是 main**，同 PR 8 模式）

**v2 规则**：

PM 操作 git（commit / cherry-pick / merge / reset / amend / rebase / checkout）**前**必走 4 步自查:

1. `git branch --show-current` 确认当前分支（**必须 == 预期 target branch**）
2. `git status --short` 看 working tree 状态（M/A/??/clean）
3. `npm test 2>&1 | grep "ℹ tests"` 验证 baseline 正确
4. 写操作清单（KEEP / DELETE / target branch / 期望 stat）

PM 操作 git **后**必走 3 步验证:

1. `git status --short` 核 working tree = 预期
2. `npm test 2>&1 | grep "ℹ tests"` 核测试数 = baseline + 增量
3. `git log --oneline -10` 核 commit chain 干净（**无 dangling**, 无 `merge(prN)` 误合并留在 chain）

**PM 自查清单**（**每次 git 操作前手打, 不抄**）:

```
操作类型:     [commit / cherry-pick / merge / reset / amend / rebase / checkout]
target branch: [main / feat/xx-xxx]
当前分支:     $(git branch --show-current)  ← **必须 == target branch**
working tree: $(git status --short | wc -l) 行
baseline tests: $(npm test 2>&1 | grep "ℹ tests" | head -1)  ← 记下数字
期望 stat:    [N files / M insertions]
KEEP 清单:    [每行一个文件路径]
DELETE 清单:  [每行一个文件路径]
```

**反 anti-pattern**（F-5 教训的延伸）:

- ❌ 不查分支直接 commit（PR 8/9 教训：subagent 自动 checkout -b，PM 接管时分支已变）
- ❌ 不查 working tree 直接 cherry-pick（PR 7 教训）
- ❌ 不跑 npm test 直接 merge（F-5 教训延伸：main 历史不干净会污染）
- ❌ 不列 KEEP/DELETE 直接 git rm（F-5 教训）
- ❌ 操作后不 3 步验证（多次教训）
- ❌ **commit body 不写"hook skipped"**（用 `--no-verify` 必须声明原因）

**subagent prompt 必带"commit 重试上限"章节**:

派活时 prompt 末尾加（**所有派活都带, 不是 PR 7 教训特例**）:

```
## commit 重试上限 (PM 接管触发条件)

pre-commit hook (lint-staged + size-check + commitlint) 跑完后, 失败时:
- 第 1 次失败: 看具体错误, 修
- 第 2 次失败: 修
- **第 3 次失败: 跑 `git commit --no-verify -m "..."` 跳过 hook, 在 commit body 注明 "hook skipped (3 retries): 原因"**
- 仍败或 30 分钟 timeout = PM 接管
- 完工必给: `git log` 输出 + `git show --stat` 输出 + `npm test` 输出 + 任何自查发现
```

---

## 监督机制

- **PR review**：reviewer 看到任一反模式 → reject
- **CI 自动**：编码规则清单的 7 条硬约束自动检查
- **每周末 PM 复盘**：哪个规则被绕过了、为什么
- **季度回看**：哪些反模式已不反了（v3 演化），哪些仍顽固

---

## ANTI_PATTERNS 总表（速查）

| 类别        | #   | 反模式                                  | v1 教训位置   |
| ----------- | --- | --------------------------------------- | ------------- |
| A 模块拆分  | A-1 | 按行数拆模块                            | retro-03      |
| A           | A-2 | 跨模块直接 import 业务函数              | retro-03      |
| A           | A-3 | Provider 同一份写 2 遍                  | retro-03      |
| A           | A-4 | Config 硬读 process.env                 | retro-02      |
| A           | A-5 | HookManager 和 EventBus 共存            | retro-03      |
| B Hygiene   | B-1 | 文档承诺 ignore ≠ 实际 ignore           | retro-02/03   |
| B           | B-2 | 散点活不分类就接                        | retro-01      |
| B           | B-3 | working tree 脏文件未清理               | retro-01      |
| C 派活      | C-1 | 派活 prompt 只给目标不给验收            | retro-02      |
| C           | C-2 | 信 subagent 自报                        | retro-02      |
| C           | C-3 | 派活没带 backup 5 件套就改凭据          | retro-02      |
| C           | C-4 | spawn 不带 session-key 前缀             | retro-02      |
| D Tool Call | D-1 | tool_calls 格式错                       | retro-03      |
| D           | D-2 | 无 MAX_TOOL_ROUNDS 限制                 | retro-03      |
| D           | D-3 | 工具执行无 try/catch                    | retro-03      |
| E PM 节奏   | E-1 | W2 准备期当 W2 启动期                   | retro-01      |
| E           | E-2 | 周报只讲做了什么不讲没做什么            | retro-01      |
| F v2 启动期 | F-1 | lint-staged 不分文件类型                | PR 1 修复     |
| F           | F-2 | mini-YAML 解析不写嵌套支持              | PR 3 修复     |
| F           | F-3 | 测试设计按理想逻辑而非实际业务          | PR 3 修复     |
| F           | F-4 | PR 500 行约束按主观自报不算 git stat    | PR 5 修复     |
| F           | F-5 | cherry-pick 拆 commit 时漏 rm 文件      | PR 7 修复     |
| F           | F-6 | pm 操作 git 缺"4 步自查 + 3 步验证"反射 | PR 7/8/9 修复 |

**共 23 条反模式**（v1 抄 17 条 + v2 启动期新增 6 条 F-1/2/3/4/5/6）。

---

_2026-06-06，老王（Hermes）记录。v2 启动日 D-0：F-1/2/3 抄 + F-4 (PR 5 教训) + F-5 (PR 7 拆 commit 教训) + F-6 (PR 7/8/9 反复 bug 教训)。F-4: 500 行硬约束走 git stat, 0.4% 弹性。F-5: cherry-pick 拆 commit 高危, KEEP+DELETE 双重核对。F-6: pm 操作 git 必走 4 步自查 + 3 步验证, subagent prompt 必带 commit 重试上限。_
