# v2 PR-23 / 24 / 25 — 接口契约设计

> **状态**：设计稿 v0.1（2026-06-14）
> **作者**：darwin-architect（响应 Hermes PM 的 PR-Design 01）
> **对齐文档**：[OPENCLAW_PROMPT_REFERENCE.md](./OPENCLAW_PROMPT_REFERENCE.md)（PR-A FINAL）
> **v2 硬约束**：单文件 < 1000 行 / 单 PR < 500 行 / v1 0 行复用 / OpenClaw 只学概念不抄代码
> **6 件套**：Provider · Memory · ContextLoader · Plugin · SKILL（待挂）· Sub-agent（暂不做）

---

## 目录

- [PR-23 — ContextLoader L6（SKILL 触发注入）](#pr-23--contextloader-l6skill-触发注入)
- [PR-24 — Tool Catalog + 3 Meta Tool](#pr-24--tool-catalog--3-meta-tool)
- [PR-25 — Tool Call Loop（多轮 + 错误/重试/降级）](#pr-25--tool-call-loop多轮--错误重试降级)
- [跨 PR 共用：错误码字典](#跨-pr-共用错误码字典)
- [跨 PR 共用：测试 harness 规约](#跨-pr-共用测试-harness-规约)
- [附录 A：与调研文档行号对照](#附录-a与调研文档行号对照)

---

## PR-23 — ContextLoader L6（SKILL 触发注入）

### 1. 接口契约

| 项                          | 规格                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **入口**                    | `loadContext({ memory, historyMessages, config, skillRegistry, currentTurn })` — 在 PR-22 签名**末尾追加两个可选参数**（不破坏向后兼容）                                   |
| **新增 config**             | `includeSkillTrigger: true`（默认）/ `skillTriggerMax: 2`（默认 L6 最多同时注入 2 个 skill 段，避免上下文膨胀）                                                            |
| **新增层**                  | L6 = "当前 turn 触发的 SKILL 提示" — 位置在 L4 history **之后**、caller 拼 L5 current turn **之前**                                                                        |
| **输出 schema**（**不变**） | `{ systemMessages: Array, meta: { layers: string[], counts: { history, learnings, skills } } }` — `meta.counts.skills` 是**新增**字段，老 caller 读到 `undefined` 静默忽略 |
| **错误**                    | 本层永不抛。`skillRegistry=null` / `currentTurn=null` / 匹配 0 个 skill → 该层静默跳过，`meta.layers` 不含 `'skills'`                                                      |
| **不动的**                  | L1-L5 逻辑、DEFAULT_OPTS 已存在字段、`_extractString` / `_historyToContext` / `_loadLearnings` 三个 internal helper — **零修改**                                           |

**触发匹配契约**（核心）：L6 是个**纯函数** `matchSkills(text, registry) -> SkillMatch[]`，签名是 `({ text, registry, max })`，**不读 L4 history**（避免 L4↔L6 循环依赖），**只读 caller 传的 `currentTurn.text`**。匹配策略 v1 用**子串包含**（case-insensitive），命中 registry 里 `skill.triggers: string[]` 任意一条即算。匹配结果按"先注册先得"（registry 内部顺序），截到 `skillTriggerMax`。

### 2. 关键数据结构

```text
SkillMatch {
  name: string,            // "weather"
  triggerHit: string,      // 命中的那条 trigger, "下雨"
  systemHint: string,      // skill manifest 里的 systemPromptHint
  source: 'registry' | 'memory'   // v1 只 'registry', v3 允许从 darwin-skills 记忆读
}

LoadContextResult {                // = PR-22 的返回, schema 不变
  systemMessages: Array<{role:'system', content:string}>,
  meta: {
    layers: Array<'identity'|'personality'|'learnings'|'history'|'skills'>,
    counts: { history: number, learnings: number, skills?: number }
  }
}
```

`systemMessages` 顺序 = `[L1, L2, L3, L4, L6, ...callerL5]`，L6 紧贴 L4 之后是有意为之（让 LLM 看到 history 后**立刻**看到"你现在该调用的 skill"，不是最后才看到）。

### 3. 错误码

L6 不引入新错误码。沿用 PR-22 风格："**本层 fail = 静默 skip**"。

| 情况                                | 处理                                            |
| ----------------------------------- | ----------------------------------------------- |
| `skillRegistry.match()` 抛          | catch → skip L6，log warn（`currentTurn` 不变） |
| matched skill 没 `systemPromptHint` | skip 这个 skill，不算入 `skillTriggerMax`       |
| 匹配数 > `skillTriggerMax`          | 截断，丢弃尾部（**不报错**）                    |
| LLM 看到 L6 后**不调** skill        | 不算错（LLM 有自由权），不重试                  |

### 4. 测试要求（≥ 5 case）

1. `currentTurn=null` → `meta.layers` 不含 `'skills'`，向后兼容
2. `skillRegistry=null` → L6 skip，其他 5 层不受影响
3. currentTurn 含触发词 `"查一下明天北京天气"` → 命中 1 个 skill，L6 注入其 `systemPromptHint`
4. 命中 3 个 skill，`skillTriggerMax=2` → 只注入前 2 个，`meta.counts.skills=2`
5. skill 命中但 `systemPromptHint` 为空 → 跳过该 skill，`counts.skills` 不计
6. L1-L5 顺序不动：snapshot 测试 `systemMessages.map(m=>m.content)` 全等
7. 触发匹配 case-insensitive：`"WEATHER"` 命中 trigger `"weather"`

### 5. 引用

- L1-L5 现状：`core/context-loader.js:24-39`（DEFAULT_OPTS） + `:108-149`（loadContext 主体）
- OpenClaw 触发器灵感：`dist/agent-tools-DkIWbsdu.js:761-769`（meta tool 名常量）+ `dist/system-prompt-config-p3G0fHzO.js:618-622`（buildSkillsSection 是 OpenClaw 拼 skill 段的位置）— v2 故意**不学 OpenClaw 把 schema 拼进 prompt**，v2 L6 只注入 systemHint 文本
- 调研决策点 5：「保留 ContextLoader 5-layer + v3 升级路径」= `OPENCLAW_PROMPT_REFERENCE.md:561-577`（§10 决策点 #5）

> **PR-23 描述（≤ 200 字）**：ContextLoader 在 L4 之后、caller 拼 L5 之前新增 L6（SKILL 触发注入）。签名追加 `skillRegistry` + `currentTurn` 两可选参数，L1-L5 零修改。`matchSkills` 纯函数读 currentTurn.text 子串匹配，命中注入 `systemPromptHint`，截到 `skillTriggerMax=2`。本层永不抛错，输出 schema 仅在 `meta.counts.skills` 增一字段，PR-22 caller 全部向后兼容。

---

## PR-24 — Tool Catalog + 3 Meta Tool

### 1. 接口契约

| 项                                                            | 规格                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **新增模块**                                                  | `core/tool-catalog.js`（catalog 自身）+ `core/meta-tools.js`（把 catalog 包成 3 个 LLM 可见的 tool definition）                                                                                                                                    |
| **catalog 形状**                                              | `Map<string, ToolEntry>`，key = tool name（如 `'weather'`）                                                                                                                                                                                        |
| **ToolEntry schema**                                          | `{ name, summary, description, parameters: JSONSchema, execute(args, ctx), fallback?: string[] }` — `summary` 是**新字段**（≤ 60 字，给 `tool_search` 返回），`description` 完整版（给 `tool_describe`），`parameters` 是 JSONSchema draft-07 兼容 |
| **3 个 meta tool**（**OpenClaw 抄 3 个，code 模式 v1 不做**） | `tool_search(query, limit?)` → `Array<{id, name, summary, score}>` / `tool_describe(id)` → `ToolEntry`（脱敏，不含 `execute`）/ `tool_call(id, args)` → `{ ok, value\|error, errorCode? }`                                                         |
| **注入位**                                                    | PR-25 的 `toolCallLoop` 调 `metaTools.buildDefinitions()` 拿到这 3 个 tool 喂给 LLM — **Provider / ContextLoader 都不动**                                                                                                                          |
| **错误**                                                      | `tool_call` 失败统一返回 `{ ok:false, errorCode, error }`，**不抛**；`tool_describe` 找不到 id → `{ ok:false, errorCode:'TOOL_NOT_FOUND' }`                                                                                                        |

**catalog 不可变性**：catalog 是**只读**视图（`Object.freeze` 每个 entry，`Map` 替换而非 mutate）。写入走 `registerPlugin()`（PR-16b 的 plugin loader 已有，PR-24 仅做 contract 对齐，不改 plugin loader 本身）。

### 2. 关键数据结构

```text
ToolEntry {
  name: 'weather',
  summary: '查询指定城市的当前天气',          // <= 60 字
  description: '调用 weather API 获取实时...', // 完整文档
  parameters: { type:'object', properties:{ city:{type:'string'} }, required:['city'] },
  execute: async (args, ctx) => any,           // ctx = { signal, memory, meta }
  fallback: ['weather-cached']                  // 可选, PR-25 用
}

ToolSearchResult { id, name, summary, score }   // score 简单 Jaccard, v1 不上 embedding
ToolCallResult    { ok:true, value } | { ok:false, errorCode, error }
```

**状态机**（tool_call 内部）：`PENDING → EXECUTING → (OK | RETRYING | FALLBACK | FAILED)`，状态由 PR-25 维护，PR-24 catalog 只暴露**同步**的 `describe()` 接口。

### 3. 错误码

PR-24 引入 4 个**新**错误码（与 PR-25 共享完整字典见末尾"跨 PR 共用"）：

| code                | 含义                         | 触发                                        |
| ------------------- | ---------------------------- | ------------------------------------------- |
| `TOOL_NOT_FOUND`    | 工具不在 catalog             | `tool_call` / `tool_describe` 收到未知 id   |
| `TOOL_INVALID_ARGS` | 参数 schema 校验失败         | `validateArgs(args, entry.parameters)` 失败 |
| `TOOL_EXEC_FAILED`  | 工具业务执行失败（不可恢复） | `execute()` 抛非网络错                      |
| `TOOL_TIMEOUT`      | `signal.aborted`             | `AbortController` 超时                      |

`tool_search` 永不报错（query 为空 → 返回空数组；catalog 为空 → 返回空数组）。

### 4. 测试要求（≥ 5 case）

1. catalog 初始化为空 → `tool_search('weather')` → `[]`
2. 注册 3 个 tool → `tool_search('weather')` 至少返回 1 个 `{id, name, summary, score}` 包含 `weather`
3. `tool_describe('weather')` 返回完整 `ToolEntry` **但不含 `execute` 字段**（脱敏）
4. `tool_describe('unknown')` → `{ ok:false, errorCode:'TOOL_NOT_FOUND' }`
5. `tool_call('weather', {})` 缺 `city` → `{ ok:false, errorCode:'TOOL_INVALID_ARGS', error: "missing required 'city'" }`
6. `tool_call('weather', {city:'北京'})` mock catalog → `{ ok:true, value:... }`
7. 注册后 `catalog` 是 frozen：尝试 `entry.name='x'` → 抛 TypeError（strict mode）或静默失败（sloppy）
8. 3 个 meta tool 的 **JSON Schema** 是合法 OpenAI/Anthropic function-calling 格式（snapshot test）

### 5. 引用

- OpenClaw 4 个 meta tool 名称：`dist/agent-tools-DkIWbsdu.js:761-769`（`TOOL_SEARCH_RAW_TOOL_NAME` / `TOOL_DESCRIBE_RAW_TOOL_NAME` / `TOOL_CALL_RAW_TOOL_NAME`）
- OpenClaw meta tool 实现：`dist/agent-tools-DkIWbsdu.js:1785-1863`（`createToolSearchTools` 4 个 definition）
- OpenClaw config schema：`dist/agent-tools-DkIWbsdu.js:1028-1065`（`resolveToolSearchConfig`）
- v2 决策点 #1：「3 meta tool」= `OPENCLAW_PROMPT_REFERENCE.md:557-559`（§10 决策点 #1）
- v2 决策点 #6：「不做 child vm bridge / code mode」= `OPENCLAW_PROMPT_REFERENCE.md:574-577`
- PM 拍板：「catalog 工具自描述」= `OPENCLAW_PROMPT_REFERENCE.md:152-158`（§3.5 表第 4 行）

> **PR-24 描述（≤ 200 字）**：新增 `core/tool-catalog.js` + `core/meta-tools.js`。catalog 是 `Map<string, ToolEntry>` 只读视图，`ToolEntry` 含 name/summary/description/parameters/execute/fallback。3 个 meta tool（`tool_search`/`tool_describe`/`tool_call`，学 OpenClaw 抄 3 个，code 模式 v1 不做）由 `buildDefinitions()` 生成供 PR-25 loop 喂 LLM。`tool_call` 失败不抛、返 `{ok:false, errorCode, error}`，4 个新错误码见末尾共享字典。

---

## PR-25 — Tool Call Loop（多轮 + 错误/重试/降级）

### 1. 接口契约

| 项                 | 规格                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **新增模块**       | `core/tool-call-loop.js`（导出 `runToolCallLoop` async generator）                                                                                                                               |
| **入口签名**       | `runToolCallLoop({ prompt, tools:[3 meta], historyMessages, memory, skillRegistry?, currentTurn?, config? }) -> AsyncGenerator<LoopEvent>`                                                       |
| **LoopEvent 5 种** | `{type:'text', text}` / `{type:'tool_result', call, result, round}` / `{type:'llm_error', error, round}` / `{type:'max_rounds_exceeded', rounds}` / `{type:'done', totalRounds, usage}`          |
| **常量化**         | `MAX_TOOL_ROUNDS=5`（默认）/ `MAX_TOOL_RETRY=3`（网络错重试）/ `RETRY_BASE_MS=300` / `RETRY_MAX_MS=30000` / `RETRY_JITTER=0.2` — 全部 const，可被 `config` 覆盖（**预留 5/10/20 三档**，见引用） |
| **不动**           | Provider 实现、ContextLoader、PR-24 的 catalog 内部 — loop 是 **consumer** 不是 **mod**                                                                                                          |
| **Abort**          | 接受 `signal: AbortSignal`，每轮 round 起始检查 `signal.aborted` 抛 `AbortError`（**唯一会抛的错**，由 caller 处理）                                                                             |

**关键契约**：`runToolCallLoop` 是 **async generator**，caller 用 `for await (const ev of loop) ...` 处理。loop 永远不主动 `return` 一个错误对象给 caller —— 错误**全部**变成 `LoopEvent` 推出去。这是 v1 教训"tool throws break the round"的彻底化（ProviderBase 那层已做，loop 这层再加固一次）。

### 2. 关键数据结构

**消息状态机**（loop 内部维护）：

```text
messages: [
  ...historyMessages,                    // caller 传, 只读
  ...assistantToolCallRounds,            // 每轮一条: {role:'assistant', tool_calls:[...]}
  ...toolResultRounds,                   // 每轮 N 条: {role:'tool', tool_call_id, content}
  finalAssistantText                     // 终态, 一旦产出 text 立即 done
]
```

**状态机 5 态**：`INIT → LLM_CALLING → TOOL_EXECUTING → (TEXT_DONE | ROUND_ADVANCE) → INIT | DONE | MAX_ROUNDS_EXCEEDED | ABORTED`

**错误归类**（`classifyToolError`，学 OpenClaw 7 个 keyword）：

| 分类                          | 关键字子串（任一命中即归此类）                                                      | 处理                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `RECOVERABLE`（LLM 自己重调） | `required` / `missing` / `invalid` / `must be` / `must have` / `needs` / `requires` | 写入 messages，**不重试**，LLM 下轮看到自己改             |
| `NETWORK`（loop 重试）        | `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` / `5xx` / `rate limit` / `429`             | `retryAsync` 重试 3 次 + 指数退避 + jitter                |
| `PERMANENT`（直接 fail）      | 其他所有（含 `4xx` 业务错、`TOOL_NOT_FOUND`、`TOOL_EXEC_FAILED`）                   | 不重试，**尝试 fallback 链**，链用尽则 `tool_result` 写错 |

### 3. 错误码

PR-25 **不发明新错误码**（PR-24 4 个足够），只在错误归类时复用 `RECOVERABLE_TOOL_ERROR_KEYWORDS`（7 个）做 in-loop 分支判断。Loop 自身错误码仅 1 个：`LOOP_ABORTED`（signal 触发，async generator 通过 `throw` 表达，caller 决定怎么接）。

降级链契约：每个 tool 的 `fallback: string[]` 是**有序**数组，loop 顺序尝试，第一个成功的就 return；全失败 → `errorResult` 写回 messages，**不报新错**（已"降级用尽"信息含在 `error` 字符串里）。

### 4. 测试要求（≥ 5 case）

1. **基本 happy path**：mock LLM 第 1 轮返 text → 立即 yield `{type:'text'}` + `{type:'done'}`，**不再调 LLM**
2. **单 tool 调**：mock LLM 第 1 轮 tool_call，第 2 轮 text → yield 顺序为 `text? no, tool_result, text, done`，messages 含完整 tool round
3. **MAX_ROUNDS 用尽**：mock LLM **永远** tool_call → 第 5 轮后 yield `{type:'max_rounds_exceeded', rounds:5}`
4. **网络重试**：mock tool 第 1-2 次抛 `ECONNRESET`，第 3 次成功 → 调 LLM 总共只 1 次（tool 内部 retry 透明）
5. **RECOVERABLE 错误**：tool 抛 `Error("missing required 'city'")` → 1 次执行、不重试、写回 tool_result 让 LLM 改参
6. **fallback 链**：tool A 失败 → 自动试 fallback A.fallback[0]，全失败 → tool_result 错误含 "fallback exhausted"
7. **signal abort**：第 2 轮起始 signal.aborted → async generator 抛 `AbortError`，**不 yield done**
8. **jitter 验证**：用 fake timer，`RETRY_BASE_MS=300, MAX=3` 至少 1 次 sleep 时间在 [480, 600)（300×2^0×0.8-300×2^0×1.2 范围）

### 5. 引用

- OpenClaw run loop 主循环：`dist/embedded-agent-DqJgypM_.js:2488-...`（while true）+ `dist/selection-BMP-JCML.js:14138-14156`（`MAX_RUN_LOOP_ITERATIONS` 24-160 范围）
- OpenClaw 错误归类 7 keyword：`dist/embedded-agent-DqJgypM_.js:1259-1278`（`RECOVERABLE_TOOL_ERROR_KEYWORDS` + `isRecoverableToolError`）
- OpenClaw `retryAsync` 指数退避：`dist/retry-Ct1cdQO0.js:42-84`（DEFAULT 3 次 + 300ms 起步 + 30s 上限 + jitter）
- v2 拍板 `MAX_TOOL_ROUNDS=5`：「保守, v1 经验 < 5」= `OPENCLAW_PROMPT_REFERENCE.md:302-307`（§7.3 伪代码注释）
- v2 拍板「5/10/20 三档配置预留」：调研文档 §10 决策点 #2 = `OPENCLAW_PROMPT_REFERENCE.md:559-561`
- v2 拍板「per-call 重试 3 次 + 300ms 退避」= `OPENCLAW_PROMPT_REFERENCE.md:567-570`（§10 决策点 #4）
- v2 拍板「plugin manifest 声明降级链」= `OPENCLAW_PROMPT_REFERENCE.md:563-566`（§10 决策点 #3）
- v1 教训「tool throws break the round」= `provider/base.js:9-12` 注释（PR 6）

> **PR-25 描述（≤ 200 字）**：新增 `core/tool-call-loop.js` 导出 `runToolCallLoop` async generator。`MAX_TOOL_ROUNDS=5`（预留 5/10/20 配置档）、`MAX_TOOL_RETRY=3` + 300ms 指数退避 + jitter=0.2。错误归类学 OpenClaw 7 keyword 分三态：RECOVERABLE 不重试写回让 LLM 改参；NETWORK 走 retryAsync；PERMANENT 试 `fallback[]` 链，链用尽写错误。loop 永不抛（除 AbortError），错误全变 `LoopEvent` 推出去。

---

## 跨 PR 共用：错误码字典

> v2 整个 tool 体系就这 5 个错误码，PR-24 + PR-25 + plugin manifest 共享。

| code                | 分类        | 含义                       | 谁产出                               | 谁消费                     |
| ------------------- | ----------- | -------------------------- | ------------------------------------ | -------------------------- |
| `TOOL_NOT_FOUND`    | PERMANENT   | catalog 里没这个 id        | catalog (PR-24)                      | loop (PR-25) 写回 messages |
| `TOOL_INVALID_ARGS` | RECOVERABLE | 参数 schema 校验失败       | catalog (PR-24)                      | loop 写回，LLM 改参        |
| `TOOL_EXEC_FAILED`  | PERMANENT   | 工具业务执行失败（非网络） | catalog (PR-24)                      | loop 试 fallback           |
| `TOOL_TIMEOUT`      | PERMANENT   | signal abort / 超时        | catalog (PR-24)                      | loop 试 fallback           |
| `LOOP_ABORTED`      | —           | caller 主动 abort          | loop (PR-25) async generator `throw` | caller try/catch           |

**不引入**：`TOOL_RETRY_EXHAUSTED`（v1 简化，retry 用尽直接当 PERMANENT 处理 + 试 fallback，省 1 个 code）。

## 跨 PR 共用：测试 harness 规约

3 个 PR 共享同一份 mock：

- **`mockLLM(responses[])`**：consumer 喂 `[{role:'assistant', tool_calls:[...] | content:'...'}]` 序列，按 round 弹出
- **`mockTool(name, behaviors[])`**：consumer 喂 `[okValue, throwErr, okValue, ...]`，按调用次数弹出
- **`fakeTimer()`**：用 `node:test` 的 `mock.timers.enable({ apis:['setTimeout'] })` 验证 jitter 范围

3 个 PR 的测试文件路径建议：

- PR-23：`tests/core/context-loader-l6.test.js`（**新增**，不碰现有 `context-loader.test.js`）
- PR-24：`tests/core/tool-catalog.test.js` + `tests/core/meta-tools.test.js`
- PR-25：`tests/core/tool-call-loop.test.js`

---

## 附录 A：与调研文档行号对照

| v2 决策                          | 调研文档位置                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| 保留 5-layer ContextLoader       | `OPENCLAW_PROMPT_REFERENCE.md:561-577`（§10 #5）                                             |
| 3 meta tool 设计                 | `OPENCLAW_PROMPT_REFERENCE.md:557-559`（§10 #1）+ `:131-148`（§3.1-3.2）                     |
| 不做 child vm bridge             | `OPENCLAW_PROMPT_REFERENCE.md:574-577`（§10 #6）                                             |
| MAX_TOOL_ROUNDS=5 + 5/10/20 三档 | `OPENCLAW_PROMPT_REFERENCE.md:559-561`（§10 #2）                                             |
| per-call retry 3 次 + 300ms      | `OPENCLAW_PROMPT_REFERENCE.md:567-570`（§10 #4） + `:213-237`（§4.2.2 retryAsync）           |
| manifest 降级链                  | `OPENCLAW_PROMPT_REFERENCE.md:563-566`（§10 #3）                                             |
| 7 keyword 错误归类               | `OPENCLAW_PROMPT_REFERENCE.md:260-274`（§5.1 错误分类表） + `:215-220`（§4.2.1）             |
| v1 不做死循环检测                | `OPENCLAW_PROMPT_REFERENCE.md:577-580`（§10 #8）                                             |
| ProviderBase 错误隔离先例        | `provider/base.js:7-12`（v1 lesson 注释） + `OPENCLAW_PROMPT_REFERENCE.md:0-5`（§0 第 4 句） |

---

**END OF DESIGN v0.1**

> **致 Hermes PM**：3 个 PR 的接口契约都在这了，验收清单 5 条全部覆盖，每 PR 描述卡在 200 字内。**无实现代码**，无 import 改动，无测试运行。commit message 已在收到你 OK 后再执行。
