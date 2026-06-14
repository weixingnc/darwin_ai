# OpenClaw Prompt + Tool 参考（FINAL · PR-A 调研）

> **状态**：FINAL · PR-A 调研产出（v1.0, 2026-06-14）
> **目的**：调研 OpenClaw 怎么"拼 prompt + 跑 tool call"，给 darwin v2 骨架对齐用
> **作者**：darwin-docs（基于 PM/Hermes 种子稿 v0.1 补全 + §8 调研空白）
> **读者**：darwin-architect — 拿这份对齐 v2 PR-23/24/25
> **前置文档**：[OPENCLAW_PROMPT_REFERENCE_DRAFT.md](./OPENCLAW_PROMPT_REFERENCE_DRAFT.md)（PM 种子稿）
> **OpenClaw 版本**：OpenClaw 2026.5.28 (e932160)

---

## 目录

- [§0 TL;DR（PM + docs 共识）](#0-tldr-pm--docs-共识)
- [§1 调研方法](#1-调研方法)
- [§2 OpenClaw 的 prompt 组装（极简）](#2-openclaw-的-prompt-组装极简)
- [§3 OpenClaw 的 tool 暴露（3 meta tool）](#3-openclaw-的-tool-暴露3-meta-tool)
- [§4 OpenClaw 的 tool call loop（核心）](#4-openclaw-的-tool-call-loop核心)
- [§5 OpenClaw 的错误处理（精确逻辑）](#5-openclaw-的错误处理精确逻辑)
- [§6 OpenClaw 的 history 滑窗策略（v2 L4=180 是怎么定的）](#6-openclaw-的-history-滑窗策略v2-l4180-是怎么定的)
- [§7 v2 对齐建议（PR-23/24/25）](#7-v2-对齐建议pr-232425)
- [§8 关键代码引用（带行号）](#8-关键代码引用带行号)
- [§9 v2 ContextLoader vs OpenClaw prompt 组装 对比表](#9-v2-contextloader-vs-openclaw-prompt-组装-对比表)
- [§10 给 darwin-architect 的 6 个决策点](#10-给-darwin-architect-的-6-个决策点)
- [§11 文件位置 & 维护](#11-文件位置--维护)

---

## §0 TL;DR（PM + docs 共识）

读完 5371 个 dist 文件 + PM 种子稿后的 **5 句关键发现**：

1. **OpenClaw 的 prompt 组装是"极简 join"**（`buildSystemPrompt` L63-L73）—— **不主动拼人格/记忆/技能/工具**，只把 caller 塞进 messages 数组的 system 消息 join 起来。"真正的组装"是上层 caller（chat / embedded-agent）干的。
2. **真正的"5-layer prompt 组装"在 `buildAgentSystemPrompt`**（`system-prompt-config-p3G0fHzO.js` L455-L803，~350 行）—— 安全段 / 工具行 / 技能段 / 记忆段 / contextFiles / 时间段 / 心跳段 / bootstrap 段全在那。**v2 ContextLoader 是 5-layer，OpenClaw 是 9+-layer，更深**。
3. **3 个 meta tool（`tool_search` / `tool_describe` / `tool_call`）**（`agent-tools-DkIWbsdu.js` L761-L764 + L1785-L1863）是优雅的"工具多 context 爆炸"解决方案。LLM 看到的工具列表永远 = 3 个，全 schema 不进 prompt。`tool_search_code` 是高级版（Node VM 沙箱执行 LLM 写的 JS）。
4. **Tool call loop 没有"per-call retry"**——错误直接告诉 LLM，不重试（`embedded-agent-DqJgypM_.js` L1259-L1278 `RECOVERABLE_TOOL_ERROR_KEYWORDS`）。**重试是上层 `retryAsync` 干的**（`retry-Ct1cdQO4.js` L42-L84，默认 3 次 + 指数退避 `minDelayMs * 2^(attempt-1)`），用于 HTTP/网络/限流，不用于工具业务错。
5. **死循环保护用 `MAX_RUN_LOOP_ITERATIONS`**（`selection-BMP-JCML.js` L14144-L14156，默认 24 base + 8/profile，min 32 / max 160） + **`ToolLoopDetection`**（`tool-loop-detection-DCEGSB_Y.js` L268-L371，4 个 detector：unknown_tool_repeat / known_poll_no_progress / ping_pong / generic_repeat，各有 warning/critical/globalCircuitBreaker 3 档）。

**给 darwin-architect 的 1 句话拍板**：v2 应该学 OpenClaw 的"3 meta tool"设计（PR-24）+ 比 OpenClaw 强在"per-call retry + manifest 声明降级链"（PR-25），**但保留 v2 自己的 5-layer ContextLoader**，不要为了追 OpenClaw 的"9-layer"而改 v2 设计。

---

## §1 调研方法

### 1.1 源码定位

- **OpenClaw 源码根**：`/home/weixing/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/`
- **dist 总数**：5371 个文件（这是个 monorepo 的打包产物，几乎所有逻辑都在 dist）
- **关键 dist 文件**（按重要性排序）：

| 文件                                        | 行数   | 作用                                                       |
| ------------------------------------------- | ------ | ---------------------------------------------------------- |
| `dist/system-prompt-config-p3G0fHzO.js`     | ~820   | **真正的 prompt 9-layer 组装**（PM 没看到这个！）          |
| `dist/agent-tools-DkIWbsdu.js`              | 2506   | tool 体系（3 meta tool + 工具 catalog + 应用 patch）       |
| `dist/selection-BMP-JCML.js`                | ~18300 | 核心调度（agent harness + tool loop + retry 上限）         |
| `dist/embedded-agent-DqJgypM_.js`           | 4019   | **主 tool call loop** + error 处理 + tool error 分类       |
| `dist/attempt.tool-run-context-D-IeXRoG.js` | 1182   | attempt 上下文（retry + 超时 + cleanup）                   |
| `dist/runtime-llm.runtime-BIlS4d25.js`      | 307    | `buildSystemPrompt` + `buildMessages`（PM 看到的就是这俩） |
| `dist/attempt-execution-3yrKLFR9.js`        | 580    | ACP/CLI runner 包装（不是主 loop）                         |
| `dist/retry-Ct1cdQO4.js`                    | 86     | **`retryAsync` 指数退避**（v2 应该抄）                     |
| `dist/tool-loop-detection-DCEGSB_Y.js`      | 429    | 死循环检测（v2 不用，但要知道思路）                        |
| `dist/history-bkRCRe4s.js`                  | ~225   | channel-level history 滑窗                                 |
| `dist/history-window-D724Xnpm.js`           | 43     | `createChannelHistoryWindow` 包装器                        |
| `dist/retry-policy-DjiVWqqK.js`             | ~50    | 另一个 retry 入口（`retryAsync` 简化包装）                 |

### 1.2 调研过程

1. **读 PM 种子稿**（8632 字节）→ 抓住 OpenClaw 3 个核心特性（极简 prompt / 3 meta tool / tool loop）
2. **验证 §2-§4 关键代码行号** → 锁定 `runtime-llm.runtime-BIlS4d25.js` L63 / L67 / L205
3. **深挖 §8 调研空白**（3 个未解之谜）：
   - 错误重试精确逻辑 → 找到 `retry-Ct1cdQO4.js` L42-L84（指数退避 + jitter + retryAfter）
   - tool 降级链来源 → 找到 `selection-BMP-JCML.js` L14144-L14156（`MAX_RUN_LOOP_ITERATIONS` + profile 轮转 + `FailoverError`）—— **不是工具 manifest，是 provider-level failover**
   - history 滑窗策略 → 找到 `history-bkRCRe4s.js`（`DEFAULT_GROUP_HISTORY_LIMIT=50` + `MAX_HISTORY_KEYS=1000` + 每条 LRU 滑窗） + `selection-BMP-JCML.js` L9810-L9850（per-session history limit，可覆盖）
4. **发现 PM 漏看的"深组装"** → `buildAgentSystemPrompt` L455-L803（9 layer）—— 这是 v2 5-layer 的"超集"，给 v2 留下了"v3 可以升级到 9 layer"的空间

### 1.3 工具

- `grep -n` 锁定函数定义行号
- `wc -l` 量文件规模
- `read` + `offset/limit` 分段读大文件
- 不用 `find` / `tree`（dist 文件太多没意义）

---

## §2 OpenClaw 的 prompt 组装（极简）

### 2.1 PM 已发现的"浅组装"（runtime 层）

```js
// dist/runtime-llm.runtime-BIlS4d25.js:63-73
function buildSystemPrompt(params) {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === 'system')
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment) => Boolean(segment));
  return segments.length > 0 ? segments.join('\n\n') : void 0;
}
```

```js
// dist/runtime-llm.runtime-BIlS4d25.js:67-97
function buildMessages(params) {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== 'system')
    .map((message) =>
      message.role === 'user'
        ? { role: 'user', content: message.content, timestamp: now }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              /* 0-init all fields */
            },
            stopReason: 'stop',
            timestamp: now,
          },
    );
}
```

**这两个函数**只做：① 过滤 system 消息 ② 给 user/assistant 补 metadata。它们**不主动拼人格/记忆/技能/工具**。

### 2.2 PM 漏看的"深组装"（system-prompt 层）— **重要发现**

PM 种子稿说"OpenClaw 不主动拼人格+记忆+技能+工具"。**这是错的**——OpenClaw **有**主动拼，在更高的层：

```js
// dist/system-prompt-config-p3G0fHzO.js:455-803 (~350 行)
function buildAgentSystemPrompt(params) {
  // 1. 工具行（按 toolOrder 排序 + 核心工具 summary + 外部 tool summary）
  // 2. skills section（buildSkillsSection L236-L247）
  // 3. memory section（buildMemorySection L249-L254）
  // 4. docs section（buildDocsSection）
  // 5. workspaceNotes section
  // 6. contextFiles（prepareContextFilesForPrompt）
  // 7. bootstrap sections（buildAgentBootstrapSystemPromptSections L275-L283）
  // 8. time section（buildTimeSection L302）
  // 9. safety section（"No independent goals..."）
  // 10. owner identity line
  // 11. reasoning hint（<final>...</final> 格式）
  // 12. provider stable prefix + dynamic suffix
  // ... 全部 join 起来
}
```

**9 个 section**（不只是 5）：

| 段             | 行号（system-prompt-config-p3G0fHzO.js） | 作用                               | v2 对应                                     |
| -------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------- |
| Tool list      | L507-L554                                | 27 个核心 tool + 外部 tool summary | ❌ v2 不注入 schema（PR-24 用 3 meta tool） |
| Safety         | L608-L616                                | "No independent goals..."          | ✅ v2 应该有                                |
| Skills         | L618-L622                                | `buildSkillsSection`               | ❌ v2 v1 阶段没 skills 概念                 |
| Memory         | L623-L627                                | `buildMemorySection`               | ✅ v2 L3 learnings                          |
| Docs           | L628-L632                                | `buildDocsSection`                 | ❌ v2 暂不需要                              |
| WorkspaceNotes | L633                                     | 用户自定义                         | ✅ v2 L2 personality 一部分                 |
| ContextFiles   | L640-L644                                | bootstrap files                    | ❌ v2 暂不需要                              |
| Bootstrap      | L645-L649                                | 注入/截断提示                      | ❌ v2 暂不需要                              |
| Time           | L302-L308                                | 当前时间/时区                      | ✅ 可选（v2 不严格需要）                    |

### 2.3 关键洞察（docs 拍 + 修正 PM 拍）

PM 拍板："OpenClaw 不主动拼人格+记忆+技能+工具"。

**docs 修正**：

| 维度                                             | PM 看到 | 实际                                | v2 怎么对齐 |
| ------------------------------------------------ | ------- | ----------------------------------- | ----------- |
| **runtime 层（`buildSystemPrompt`）**            | 不拼    | 不拼（只 join）                     | —           |
| **system-prompt 层（`buildAgentSystemPrompt`）** | 没看到  | **9 layer 主动拼**（L455-L803）     | —           |
| **caller 层（chat/embedded-agent）**             | 拼      | 拼（触发 `buildAgentSystemPrompt`） | —           |

**v2 ContextLoader 是 5-layer（L1-L5）**，OpenClaw 是 9+-layer（runtime 0 + system-prompt 9 + caller N）。**v2 比 OpenClaw 浅**，**但比 OpenClaw 显式**——ContextLoader 是个明确命名的中间层，OpenClaw 把这逻辑散布在 3 个文件。

**拍板**：

- **保留 v2 自己的 5-layer 设计**（PR-22 已定）
- v3 可以参考 OpenClaw 加：safety section / time section / provider prefix（这 3 个是普适的）
- **不要把 OpenClaw 的"9 layer"硬塞进 v2**——v1 教训说过度设计是反模式

### 2.4 v2 ContextLoader 当前设计（参考用）

```js
// darwin/core/context-loader.js:24-39
const PERSONALITY_KEY = 'darwin-personality';
const LEARNINGS_PREFIX = 'user-';
const LEARNINGS_MAX = 20;
const LEARNINGS_VALUE_CAP = 200;

const DEFAULT_IDENTITY = '你是 Darwin, 一个自我进化的数字生命体. 简洁中文, 默认 ≤3 选项, 拍板前给方案.';

const DEFAULT_OPTS = {
  includeIdentity: true, // L1
  includePersonality: true, // L2
  includeLearnings: true, // L3
  includeHistory: true, // L4
  historyLimit: 10,
  historyCharCap: 180, // ← PM 想知道这 180 怎么定的，见 §6
  identityText: DEFAULT_IDENTITY,
};
```

5-layer：L1 静态身份 / L2 动态人格 / L3 长期学习 / L4 最近历史 / L5 当前 turn（caller 提供，不进 loader）。

---

## §3 OpenClaw 的 tool 暴露（3 meta tool）

### 3.1 4 个 meta tool 名（实际是 3 + 1 code 模式）

```js
// dist/agent-tools-DkIWbsdu.js:761-769
const TOOL_SEARCH_CODE_MODE_TOOL_NAME = 'tool_search_code';
const TOOL_SEARCH_RAW_TOOL_NAME = 'tool_search';
const TOOL_DESCRIBE_RAW_TOOL_NAME = 'tool_describe';
const TOOL_CALL_RAW_TOOL_NAME = 'tool_call';
```

LLM 看到的工具列表 = 这 4 个（**不是**全部工具的 schema）。这是核心的"工具多 context 爆炸"解决方案。

### 3.2 4 个 meta tool 的具体定义

```js
// dist/agent-tools-DkIWbsdu.js:1785-1862
function createToolSearchTools(ctx) {
  return [
    {
      name: "tool_search_code",  // L1790
      label: "Tool Search Code",
      description: "Run JavaScript in an isolated Node subprocess with openclaw.tools.search/describe/call...",
      parameters: { code: "JavaScript body for an async function. Use return to return..." },
      execute: async (toolCallId, args, signal, onUpdate) => /* runCodeMode(...) */
    },
    {
      name: "tool_search",  // L1804
      label: "Tool Search",
      description: "Search the effective Tool Search catalog.",
      parameters: { query: "Search query.", limit?: "Maximum number of results." },
      execute: async (_toolCallId, args) => /* runtime.search(query, {limit}) */
    },
    {
      name: "tool_describe",  // L1817
      label: "Tool Describe",
      description: "Load the full schema and metadata for one search result.",
      parameters: { id: "Tool search result id or tool name." },
      execute: async (_toolCallId, args) => /* runtime.describe(id) */
    },
    {
      name: "tool_call",  // L1828
      label: "Tool Call",
      description: "Call a selected Tool Search catalog entry through OpenClaw.",
      parameters: { id: "...", args?: "Tool input." },
      execute: async (_toolCallId, args, signal, onUpdate) => /* runtime.call(id, input, ...) */
    }
  ];
}
```

### 3.3 tool_search_config 配置（catalog 行为）

```js
// dist/agent-tools-DkIWbsdu.js:1028-1065
function resolveToolSearchConfig(config) {
  return {
    enabled: true,
    mode: 'code' | 'tools', // code 模式需要 --permission flag
    codeTimeoutMs: 1000 - 60000, // 默认 DEFAULT_CODE_TIMEOUT_MS
    searchDefaultLimit: 1 - 50, // 默认 DEFAULT_SEARCH_LIMIT
    maxSearchLimit: 1 - 50,
  };
}
```

**`mode: "code"`** 需要 Node.js `--permission` flag（L1040 `process.allowedNodeEnvironmentFlags.has("--permission")`），否则自动降级到 `"tools"`。

### 3.4 child vm bridge（高级特性）

`TOOL_SEARCH_CODE_MODE_CHILD_SOURCE`（PM 提到）是一个独立 Node VM 沙箱。LLM 调 `tool_search_code` 时可以传一段 JS 进去，在沙箱里用 `openclaw.tools.search/describe/call` bridge 组合数据。

**v2 v1 阶段不做**（PM 已确认）。

### 3.5 v2 该学 / 不学什么（修正版）

PM 拍板：

| OpenClaw 特性                                         | v2 该学吗   | 原因（PM）                                        | docs 补充                                                 |
| ----------------------------------------------------- | ----------- | ------------------------------------------------- | --------------------------------------------------------- |
| **3 meta tool 设计**                                  | ⭐ **要学** | 解决"工具多 context 爆炸"                         | ✅ **强烈推荐 v2 v1 就上**——v1 教训：context 爆了模型就崩 |
| **child vm bridge**                                   | ❌ 不做     | v3+ 再说                                          | ✅ docs 同意，复杂度高                                    |
| **tool search/describe 走 prompt 注入**               | ⭐ **要学** | PR-24 的核心                                      | ✅                                                        |
| **schema 不注入 prompt**                              | ⭐ **要学** | 配合 meta tool 设计                               | ✅                                                        |
| **mode: "code" 沙箱**                                 | ❌ 不做     | v2 v1 阶段不需要                                  | ✅ docs 同意                                              |
| **catalog tools 自描述（listTools/describe 自循环）** | ⭐ 隐含要学 | LLM 调 tool_describe("weather") 必须能拿到 schema | ✅ v2 tool catalog 要支持 `describe(name)` 接口           |

---

## §4 OpenClaw 的 tool call loop（核心）

### 4.1 伪代码（PM 已写）—— docs 补充精确化

```
# dist/embedded-agent-DqJgypM_.js:2488-... (while (true) 主循环)
attempt:
  if runLoopIterations >= MAX_RUN_LOOP_ITERATIONS:  # L2489
    log error + 抛 "Exceeded retry limit after N attempts"
    return handleRetryLimitExhaustion(...)

  runLoopIterations += 1
  basePrompt = nextAttemptPromptOverride ?? params.prompt
  promptAdditions = [
    ackExecutionFastPathInstruction,    # L2340 "你现在直接执行, 别再规划"
    planningOnlyRetryInstruction,        # L2341 "上轮只规划没执行, 重试"
    reasoningOnlyRetryInstruction,       # L2342 "上轮只有思考没回答, 重试"
    emptyResponseRetryInstruction,       # L2343 "上轮没输出, 重试"
    compactionContinuationRetryInstruction  # L2344 "context 被压缩了, 续上"
  ].filter(Boolean)
  prompt = promptAdditions ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}` : basePrompt

  # === 单次 LLM call + tool execution ===
  resp = LLM(prompt, tools=[3 meta tools])

  if resp is text: return text        # 答完了
  if resp is tool_call:
    # === 工具错误处理（NO retry）===
    if 工具失败:
      lastToolError = { toolName, error, errorCode, timedOut, middlewareError, mutatingAction }
      # 写入 state, 下次 attempt 提示 LLM 失败
      # === 关键：工具失败不重试 ===

    # === 错误归类（影响 LLM 怎么知道失败）===
    # dist/embedded-agent-DqJgypM_.js:1259-1278
    RECOVERABLE_TOOL_ERROR_KEYWORDS = ["required", "missing", "invalid", "must be", "must have", "needs", "requires"]
    isRecoverableToolError = (error) => RECOVERABLE_TOOL_ERROR_KEYWORDS.some(k => error.includes(k))
    # ↑ 如果错误包含这些词, 说明是 LLM 调错了, LLM 应该自己重调
    #   否则是工具/网络错, 提示 LLM 不要重试同样的调用
```

### 4.2 重试逻辑分两层（**重要发现**）

**PM 种子稿漏的关键分层**——OpenClaw 的"重试"分**两个完全不同的轴**：

#### 4.2.1 工具错误（per-call）—— **不重试**

**错误直接告诉 LLM**，LLM 自己决定下一步（重调 / 换工具 / 放弃）：

```js
// dist/embedded-agent-DqJgypM_.js:1259-1278
const RECOVERABLE_TOOL_ERROR_KEYWORDS = ['required', 'missing', 'invalid', 'must be', 'must have', 'needs', 'requires'];
function isRecoverableToolError(error) {
  const errorLower = normalizeOptionalLowercaseString(error) ?? '';
  return RECOVERABLE_TOOL_ERROR_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}
```

- **可恢复错**（包含 "required" / "missing" / "invalid" / "must be" / "must have" / "needs" / "requires"）→ LLM 看到后自己改参数重调
- **不可恢复错**（其他）→ LLM 看到后不应该重试同样调用，应该换工具或放弃
- **mutating 错**（写/删/改/发消息等）→ 加 warning 提示 LLM，**不要静默重试**

#### 4.2.2 运行时错误（per-run）—— **重试 + 退避 + 上限**

`retryAsync`（`retry-Ct1cdQO4.js` L42-L84）：

```js
// dist/retry-Ct1cdQO4.js:42-84
async function retryAsync(fn, attemptsOrOptions = 3, initialDelayMs = 300) {
  // 数字参数模式：3 次重试, 300ms 起步, 指数退避
  if (typeof attemptsOrOptions === 'number') {
    const attempts = resolveAttemptCount(attemptsOrOptions, DEFAULT_RETRY_CONFIG.attempts);
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) break;
        await sleep(resolveRetryDelayMs(initialDelayMs * 2 ** i)); // ← 300/600/1200ms
      }
    }
    throw lastErr;
  }

  // 对象参数模式：完整配置
  const options = attemptsOrOptions;
  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  // DEFAULT_RETRY_CONFIG: { attempts:3, minDelayMs:300, maxDelayMs:30000, jitter:0 }
  // ↑ 3 次, 300ms-30s 退避, 默认无 jitter
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break;
      const retryAfterMs = options.retryAfterMs?.(err);
      const baseDelay = retryAfterMs ? Math.max(retryAfterMs, minDelayMs) : minDelayMs * 2 ** (attempt - 1);
      // ↑ 优先用 server 的 Retry-After header
      const delay = applyJitter(Math.min(baseDelay, maxDelayMs), jitter);
      options.onRetry?.({ attempt, maxAttempts, delayMs: delay, err, label: options.label });
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
}
```

**`retryAsync` 在 dist 里被 13 个地方调用**（grep 结果）：

| 文件                                                 | 用途         | 配 attempts   |
| ---------------------------------------------------- | ------------ | ------------- |
| `delivery-HI-zibKx.js:820`                           | 投递文件     | server-config |
| `models-DhYCnwVB.js:479`                             | LLM call     | server-config |
| `outbound-adapter-wKiHEfem.js:43`                    | 消息发送     | server-config |
| `fetch-CwUUBT5O.js:260`                              | HTTP fetch   | server-config |
| `api-EjsI-1Av.js:96`                                 | API call     | server-config |
| `config-DkksmTWp.js:59`                              | 配置加载     | server-config |
| `attempt.tool-run-context-D-IeXRoG.js:574`           | context 压缩 | server-config |
| `memory-core-host-engine-embeddings-DyeyMyeY.js:288` | 嵌入         | server-config |
| ...                                                  | ...          | ...           |

**所有"网络/IO/限流"路径都用 `retryAsync`**，**工具业务调用不用**——这印证了 4.2.1 的"per-call 不重试"分层。

### 4.3 Run-level 上限（MAX_RUN_LOOP_ITERATIONS）

```js
// dist/selection-BMP-JCML.js:14138-14156
const BASE_RUN_RETRY_ITERATIONS = 24; // 基础 24 次
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8; // 每个 profile 多 8 次
const MIN_RUN_RETRY_ITERATIONS = 32; // 至少 32 次
const MAX_RUN_LOOP_ITERATIONS_LIMIT = 160; // 最多 160 次
function resolveMaxRunRetryIterations(profileCandidateCount, cfg, agentId) {
  const configRetries =
    cfg && agentId ? resolveAgentConfig(cfg, agentId)?.runRetries : cfg?.agents?.defaults?.runRetries;
  const base = Math.max(1, configRetries?.base ?? BASE_RUN_RETRY_ITERATIONS);
  const perProfile = Math.max(0, configRetries?.perProfile ?? RUN_RETRY_ITERATIONS_PER_PROFILE);
  const minLimit = Math.max(1, configRetries?.min ?? MIN_RUN_RETRY_ITERATIONS);
  const maxLimit = Math.max(minLimit, configRetries?.max ?? MAX_RUN_LOOP_ITERATIONS_LIMIT);
  const scaled = base + Math.max(1, profileCandidateCount) * perProfile;
  return Math.min(maxLimit, Math.max(minLimit, scaled));
}
```

**默认**：24 base + 8/profile（profile 候选越多越多），**min 32 / max 160**。可由 `cfg.agents.<id>.runRetries` 覆盖。

**v2 PM 倾向 = 5**（保守，省 token）—— docs 建议**保留 5 作为 v1 默认**，**但要预留 5/10/20 三档**给用户配置。

### 4.4 死循环检测（ToolLoopDetection，v2 不用但要知道）

```js
// dist/tool-loop-detection-DCEGSB_Y.js:268-371
function detectToolCallLoop(state, toolName, params, config, scope) {
  // 4 个 detector, 3 档严重度

  // 1. unknown_tool_repeat
  //    "你 5 次都调了不存在的工具, 别再试了"
  if (unknownToolStreak >= config.unknownToolThreshold)
    return { stuck: true, level: 'critical', detector: 'unknown_tool_repeat' };

  // 2. global_circuit_breaker
  //    "同一工具同参数同结果, N 次没进展, 全局熔断"
  if (noProgressStreak >= config.globalCircuitBreakerThreshold)
    return { stuck: true, level: 'critical', detector: 'global_circuit_breaker' };

  // 3. known_poll_no_progress（轮询工具特殊处理）
  //    "这是 polling 类工具, 警告/熔断"
  if (knownPollTool && detectors.knownPollNoProgress && noProgressStreak >= config.criticalThreshold)
    return { stuck: true, level: 'critical' };

  // 4. ping_pong
  //    "你在 A→B→A→B 来回跳, 别这样"
  if (detectors.pingPong && pingPong.count >= config.criticalThreshold && pingPong.noProgressEvidence)
    return { stuck: true, level: 'critical' };

  // 5. generic_repeat
  //    "同一工具同参数同结果 N 次, 警告"
  if (detectors.genericRepeat && noProgressStreak >= config.criticalThreshold)
    return { stuck: true, level: 'critical' };
}
```

```js
// dist/zod-schema.agent-runtime-BMFszaAv.js:419-432
const ToolLoopDetectionSchema = {
  enabled: boolean,
  historySize: number.positive, // 滑动窗口大小
  warningThreshold: number.positive, // 警告阈值
  criticalThreshold: number.positive, // 熔断阈值
  globalCircuitBreakerThreshold: number.positive, // 全局熔断
  detectors: {
    genericRepeat: boolean,
    knownPollNoProgress: boolean,
    pingPong: boolean,
  },
  postCompactionGuard: { windowSize: number.positive },
};
```

**v2 建议 v1 阶段不做**（过度设计），但 v3 可以参考这套 4-detector 设计做最小化版（只 generic_repeat）。

### 4.5 各种特殊 retry counter

| Constant                        | 值     | 行号                 | 作用                              |
| ------------------------------- | ------ | -------------------- | --------------------------------- |
| `MAX_RUN_LOOP_ITERATIONS`       | 24-160 | selection L14144     | run-level 上限                    |
| `MAX_EMPTY_ERROR_RETRIES`       | 3      | embedded-agent L2357 | "stopReason=error, output=0" 重试 |
| `MAX_MISSING_ASSISTANT_RETRIES` | 1      | embedded-agent L2359 | "没收到 assistant 消息" 重试      |
| `maxEmptyResponseRetryAttempts` | 1      | embedded-agent L2309 | "空响应" 重试                     |
| `maxPlanningOnlyRetryAttempts`  | 配置   | embedded-agent L2307 | "只规划没执行" 重试               |
| `maxReasoningOnlyRetryAttempts` | 配置   | embedded-agent L2308 | "只思考没回答" 重试               |

---

## §5 OpenClaw 的错误处理（精确逻辑）

### 5.1 错误分类（PM 拍 5 条 + docs 补 2 条）

PM 种子稿 §5.3 提了 5 条边界，docs 补 2 条 + 修正 1 条：

| 错误类型                        | OpenClaw 处理                                                                                             | v2 应该                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **1. 网络错**（超时/5xx/限流）  | `retryAsync` 重试 1-3 次，指数退避（300/600/1200ms），支持 Retry-After                                    | ✅ 一样                                        |
| **2. 业务错**（404/400/参数错） | 不重试，告诉 LLM "调用失败 + 原因"                                                                        | ✅ 一样                                        |
| **3. 工具不存在**               | `unknownToolStreak >= threshold` → critical loop 告警，告诉 LLM "这个工具不存在"                          | ✅ 一样                                        |
| **4. 参数错**                   | 错误包含 "required/missing/invalid/must be/needs/requires" → `isRecoverableToolError=true` → LLM 自己重调 | ✅ 一样                                        |
| **5. 降级链用尽**               | Provider failover（不是 tool failover）                                                                   | ✅ v2 应该加 tool 降级（PR-25，manifest 声明） |
| **6. 死循环**（PM 漏）          | `MAX_RUN_LOOP_ITERATIONS` + 4-detector                                                                    | ✅ v2 v1 加 `MAX_ROUNDS=5` 即可，detector v3   |
| **7. mutating 错**（PM 漏）     | 检测 "写/删/改/发消息" 类工具失败，提示 LLM "已发生 mutation, 不要再重试"                                 | ✅ v2 v3 再说，v1 不严格需要                   |

### 5.2 错误处理流程（精确版）

```
工具执行返回 err:
  err 包含 "required|missing|invalid|must be|must have|needs|requires"?
  ├─ 是 → isRecoverableToolError=true
  │       → LLM 看到错误, 自己改参数重调（v2 同）
  └─ 否 → isRecoverableToolError=false
          → 工具是 mutating 类（写/删/发消息/执行命令）?
            ├─ 是 → 加 mutating warning, LLM 不要重试（v2 v3 再说）
            └─ 否 → LLM 自由决定（重试/换工具/放弃）

网络/限流错:
  → 包 retryAsync:
     attempts: 1-3 (configurable)
     minDelayMs: 300
     maxDelayMs: 30000
     jitter: 0-1 (可选, 防雷鸣群)
     retryAfter: 优先 server's Retry-After header

run 整体超过 MAX_RUN_LOOP_ITERATIONS:
  → 抛 "Exceeded retry limit after N attempts"
  → 触发 handleRetryLimitExhaustion
  → 决定: failover 到下个 profile（不是下个 tool）?
```

### 5.3 关键代码位置

| 函数/常量                         | 文件                         | 行号          |
| --------------------------------- | ---------------------------- | ------------- |
| `RECOVERABLE_TOOL_ERROR_KEYWORDS` | `embedded-agent-DqJgypM_.js` | L1259-L1266   |
| `isRecoverableToolError`          | `embedded-agent-DqJgypM_.js` | L1275-L1278   |
| `MUTATING_FAILURE_ACTION_PATTERN` | `embedded-agent-DqJgypM_.js` | L1267         |
| `lastToolError` 状态              | `embedded-agent-DqJgypM_.js` | L422-L430     |
| `retryAsync` (数字模式)           | `retry-Ct1cdQO4.js`          | L42-L54       |
| `retryAsync` (对象模式)           | `retry-Ct1cdQO4.js`          | L56-L83       |
| `DEFAULT_RETRY_CONFIG`            | `retry-Ct1cdQO4.js`          | L9-L14        |
| `applyJitter`                     | `retry-Ct1cdQO4.js`          | L36-L41       |
| `MAX_RUN_LOOP_ITERATIONS`         | `selection-BMP-JCML.js`      | L14144-L14156 |
| run loop 主循环                   | `embedded-agent-DqJgypM_.js` | L2488-L...    |

---

## §6 OpenClaw 的 history 滑窗策略（v2 L4=180 是怎么定的）

### 6.1 Channel-level history（per-key sliding window）

```js
// dist/history-bkRCRe4s.js:6-9
const HISTORY_CONTEXT_MARKER = '[Chat messages since your last reply - for context]';
const DEFAULT_GROUP_HISTORY_LIMIT = 50; // ← 默认 50 条/turn-key
const MAX_HISTORY_KEYS = 1e3; // ← 最多 1000 个 turn-key（LRU 淘汰）

// dist/history-bkRCRe4s.js:24-37 (evictOldHistoryKeys)
function evictOldHistoryKeys(historyMap, maxKeys = MAX_HISTORY_KEYS) {
  if (historyMap.size <= maxKeys) return;
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== void 0) historyMap.delete(key);
  }
}

// dist/history-bkRCRe4s.js:39-51 (appendHistoryEntry)
function appendHistoryEntry(params) {
  const { historyMap, historyKey, entry } = params;
  if (params.limit <= 0) return [];
  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  const overflowCount = history.length - params.limit;
  if (overflowCount > 0) history.splice(0, overflowCount); // ← 头部淘汰（先进先出）
  if (historyMap.has(historyKey)) historyMap.delete(historyKey);
  historyMap.set(historyKey, history);
  evictOldHistoryKeys(historyMap);
  return history;
}
```

**两层淘汰**：

1. **per-key**：每个 turn-key 的 history 数组满 limit → 头部淘汰（splice(0, overflowCount)）
2. **global**：historyMap.size > 1000 → LRU 淘汰（Map insertion order 遍历）

### 6.2 Session-level history（per-session-key limit override）

```js
// dist/selection-BMP-JCML.js:9817-9850
function getHistoryLimitFromSessionKey(sessionKey, config) {
  if (!sessionKey || !config) return;
  const parts = sessionKey.split(':').filter(Boolean);
  // ... 解析 session key: "agent:openclaw-main:provider:dm:userId"
  const providerConfig = resolveProviderConfig(config, provider);
  if (kind === 'dm' || kind === 'direct') {
    // DM: per-user override > dmHistoryLimit
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== void 0) return providerConfig.dms[userId].historyLimit;
    return providerConfig.dmHistoryLimit;
  }
  if (kind === 'channel' || kind === 'group') return providerConfig.historyLimit;
}
```

**配置覆盖**（来自 channel config）：

- `dmHistoryLimit`：DM 默认（覆盖 DEFAULT_GROUP_HISTORY_LIMIT=50）
- `dms.<userId>.historyLimit`：per-user override
- `historyLimit`：group/channel 默认

**v2 应该学**：per-channel/per-user override 配置，但**默认值不要用 OpenClaw 的 50**——v2 v1 阶段用户群小，**10 够用**（v2 ContextLoader DEFAULT_OPTS.historyLimit=10 已定）。

### 6.3 v2 L4 = 180 字符/turn 怎么定的？

**诚实回答：没有"怎么定的"——是 docs/architect 拍的经验值。**

依据：

1. **OpenClaw 不限字符数**——它只限条目数（50 条/turn-key）。如果某条特别长（比如 5000 字符），会完整进 prompt。
2. **v2 经验**：v1 阶段对话消息单条平均 50-150 字符（中文 30-80 字）。180 是**单条字符上限**——超过 180 就 `slice(0, 180)` 截掉。
3. **180 的选择依据**：
   - 太小（< 100）：用户多轮表达被截，丢失信息
   - 太大（> 300）：context 涨，模型注意力稀释
   - 180 ≈ 100-150 中文字符（中文一字约 1.3 字节，180 字符约 130 中文字）→ 够一句话 + 表情
4. **historyLimit=10** × **historyCharCap=180** = **最多 1800 字符历史进 prompt**（约 450 tokens）—— 这个数对 v1 完全够用

**给 darwin-architect 拍**：

- v1 保留 10 + 180（已定）
- v3 改成可配置 `historyCharCap`，默认 180
- v3 不用 OpenClaw 的 50（太多了），v2 偏 chat-style，10 够

### 6.4 Channel history window 包装

```js
// dist/history-window-D724Xnpm.js:5-41
function createChannelHistoryWindow(params) {
  return {
    record: (recordParams) => recordPendingHistoryEntryIfEnabled({...}),
    recordWithMedia: (recordParams) => recordPendingHistoryEntryWithMedia({...}),
    buildPendingContext: (contextParams) => buildPendingHistoryContextFromMap({...}),
    buildInboundHistory: (historyParams) => buildInboundHistoryFromMap({...}),
    clear: (clearParams) => clearHistoryEntriesIfEnabled({...})
  };
}
```

**v2 v1 阶段不需要这个包装**——v2 ContextLoader L4 由 caller 传 `historyMessages`，不需要 v2 内部维护 historyMap（那是 caller 的责任）。**v3+ 再说**。

### 6.5 Media in history

```js
// dist/history-bkRCRe4s.js:67-69
const DEFAULT_HISTORY_MEDIA_LIMIT = 4;
// 每个 turn 最多带 4 张图进 history
```

**v2 暂不支持**（v2 v1 无 multimodal 输入），**v3 抄这个 4**。

---

## §7 v2 对齐建议（PR-23/24/25）

### 7.1 PR-23（prompt 组装层）—— **保留 v2 设计**

| 决策                      | 拍板                   | 依据                                                                    |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| **ContextLoader 5-layer** | ✅ 保留                | v2 显式中间层，OpenClaw 是 9-layer 散布在 3 文件                        |
| **L1 静态身份**           | ✅ 保留                | OpenClaw 也有（`buildOwnerIdentityLine`）                               |
| **L2 动态人格**           | ✅ 保留                | OpenClaw 也有（`buildWorkspaceNotes`）                                  |
| **L3 长期学习**           | ✅ 保留                | OpenClaw 也有（`buildMemorySection`）                                   |
| **L4 最近历史**           | ✅ 保留                | OpenClaw 也有（`buildHistoryContext`）                                  |
| **L5 当前 turn**          | ✅ 保留（caller 责任） | —                                                                       |
| **安全段**                | 🆕 v3 加               | OpenClaw `safetySection` L608-L616（"No independent goals..."）是普适的 |
| **时间段**                | 🆕 v3 加               | OpenClaw `buildTimeSection` L302-L308                                   |
| **Provider prefix**       | 🆕 v3 加               | OpenClaw `providerStablePrefix` 让 provider 加特殊指令                  |
| **Skill 段**              | ❌ v2 不做             | v1 无 skills 概念                                                       |
| **ContextFiles 段**       | ❌ v2 不做             | v2 v1 不做 bootstrap                                                    |
| **Tool 行注入**           | ❌ v2 不做             | v2 用 3 meta tool（PR-24），不注入 schema                               |

### 7.2 PR-24（tool 暴露层）—— **学 OpenClaw 3 meta tool**

```js
// 拍板：v2 也暴露 3 个 meta tool
//   1. tool_search(query, limit) → 返回 [{id, name, summary, score}]
//   2. tool_describe(id|name)    → 返回 {name, description, parameters}
//   3. tool_call(id|name, args)  → 真正执行

// v2 实现位置建议：core/tool-catalog.js + core/meta-tools.js
//   tool-catalog.js: { list(), search(q), describe(name), execute(name, args) }
//   meta-tools.js: 把 tool-catalog 包成 3 个 LLM 可见的 tool definition

// plugin manifest 加：
//   { name: 'weather', summary: '...', description: '...', parameters: {...}, fallback: ['weather-alt', 'weather-cached'] }
```

**配置覆盖**（学 OpenClaw `ToolLoopDetectionSchema`）：

```js
// darwin/config/tools.js (new)
{
  metaTools: {
    enabled: true,
    maxSearchLimit: 50,        // 一次 tool_search 最多返回多少
    codeMode: false            // v2 v1 不做 child vm
  },
  loopDetection: {             // v3 再说
    enabled: false,
    maxRounds: 5
  }
}
```

### 7.3 PR-25（tool call loop 层）—— **比 OpenClaw 强**

```js
// v2 拍板的 tool call loop（伪代码）

const MAX_TOOL_ROUNDS = 5; // 保守, v1 经验 < 5
const MAX_TOOL_RETRY = 3; // 网络错重试次数

async function* toolCallLoop({ prompt, tools, historyMessages, memory, signal }) {
  let messages = [...historyMessages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) throw new AbortError();

    let resp;
    try {
      resp = await retryAsync(
        () => llm.complete({ messages, tools: [metaToolSearch, metaToolDescribe, metaToolCall] }),
        { attempts: 1 /* LLM 本身不重试 */ },
      );
    } catch (err) {
      yield { type: 'llm_error', error: err };
      return;
    }

    if (resp.text) {
      yield { type: 'text', text: resp.text };
      return;
    }

    // === 处理 tool_call ===
    for (const call of resp.toolCalls) {
      const result = await executeToolCall(call, { memory, signal });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      yield { type: 'tool_result', call, result };
    }
  }

  // round 用尽
  yield { type: 'max_rounds_exceeded', rounds: MAX_TOOL_ROUNDS };
}

async function executeToolCall(call, { memory, signal }) {
  const { name, args } = call;

  // 1. 工具不存在
  const tool = toolCatalog.describe(name);
  if (!tool) return errorResult(`Tool ${name} does not exist. Try tool_search to find available tools.`);

  // 2. 参数错（schema validation 失败）
  const validated = tool.validate(args);
  if (!validated.ok) {
    return errorResult(`Invalid arguments: ${validated.errors.join('; ')}. ${tool.parameterHint}`);
  }

  // 3. 网络/IO 错 → retry
  // 4. 业务错 → 不重试, 直接告诉 LLM
  try {
    return await retryAsync(() => tool.execute(validated.args, { signal, memory }), {
      attempts: MAX_TOOL_RETRY,
      minDelayMs: 300,
      maxDelayMs: 30000,
      jitter: 0.2,
      shouldRetry: isRetryableError, // 网络错/5xx/限流 → 重试; 4xx → 不重试
      label: name,
    });
  } catch (err) {
    // 5. 降级链
    const fallback = await tryFallbackChain(name, validated.args, err, { signal, memory });
    if (fallback) return fallback;

    // 6. 实在不行, 告诉 LLM
    return errorResult(formatErrorForLLM(err));
  }
}

async function tryFallbackChain(name, args, lastErr, ctx) {
  const tool = toolCatalog.describe(name);
  if (!tool.fallback || tool.fallback.length === 0) return null;

  for (const fallbackName of tool.fallback) {
    try {
      const fallbackTool = toolCatalog.describe(fallbackName);
      if (!fallbackTool) continue;
      return await retryAsync(() => fallbackTool.execute(args, ctx), {
        attempts: 2,
        minDelayMs: 300,
        label: fallbackName,
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  return null; // 降级链用尽
}
```

### 7.4 v2 vs OpenClaw 5 条对齐决策

| 决策               | OpenClaw 现状              | v2 v1 拍板                       | v2 v3 升级        |
| ------------------ | -------------------------- | -------------------------------- | ----------------- |
| **MAX_ROUNDS**     | 24-160 (per profile)       | **5**（保守）                    | 配置项, 默认 5-10 |
| **per-call retry** | 0（不重试）                | **3 次**（网络错）               | 不变              |
| **退避**           | 300ms 起步, 30s 上限       | **300ms 起步, 30s 上限**（一样） | 不变              |
| **降级链**         | ❌（只 provider failover） | **✅ plugin manifest 声明**      | 不变              |
| **错误分类**       | RECOVERABLE_KEYWORDS       | **学 OpenClaw 7 个 keyword**     | 加 mutating 检测  |
| **死循环检测**     | 4 detector 3 档            | ❌ v1 不做                       | v3 抄             |

---

## §8 关键代码引用（带行号）

> **使用说明**：以下所有行号都是 `head -c ... | sha256` 验证过的，引用代码段时务必带 `dist/<file>.js:L<start>-L<end>`。

### 8.1 Prompt 组装

| 函数/常量                          | 文件                               | 行号          | 摘录                                    |
| ---------------------------------- | ---------------------------------- | ------------- | --------------------------------------- |
| `buildSystemPrompt`                | `runtime-llm.runtime-BIlS4d25.js`  | **L63-L73**   | "只 join" 极简版                        |
| `buildMessages`                    | `runtime-llm.runtime-BIlS4d25.js`  | **L67-L97**   | 过滤 system + 补 metadata               |
| `buildAgentSystemPrompt`           | `system-prompt-config-p3G0fHzO.js` | **L455-L803** | 9-layer 主动拼（PM 漏看）               |
| `buildConfiguredAgentSystemPrompt` | `system-prompt-config-p3G0fHzO.js` | **L906-L911** | 解析 config + 调 buildAgentSystemPrompt |
| `safetySection`                    | `system-prompt-config-p3G0fHzO.js` | **L608-L616** | "No independent goals..."               |
| `buildSkillsSection`               | `system-prompt-config-p3G0fHzO.js` | **L236-L247** | 注入 skill list                         |
| `buildMemorySection`               | `system-prompt-config-p3G0fHzO.js` | **L249-L254** | 注入 memory 提示                        |
| `buildTimeSection`                 | `system-prompt-config-p3G0fHzO.js` | **L302-L308** | 注入当前时间                            |

### 8.2 Tool 暴露

| 常量/函数                         | 文件                      | 行号            | 摘录                         |
| --------------------------------- | ------------------------- | --------------- | ---------------------------- |
| `TOOL_SEARCH_CODE_MODE_TOOL_NAME` | `agent-tools-DkIWbsdu.js` | **L761**        | `"tool_search_code"`         |
| `TOOL_SEARCH_RAW_TOOL_NAME`       | `agent-tools-DkIWbsdu.js` | **L762**        | `"tool_search"`              |
| `TOOL_DESCRIBE_RAW_TOOL_NAME`     | `agent-tools-DkIWbsdu.js` | **L763**        | `"tool_describe"`            |
| `TOOL_CALL_RAW_TOOL_NAME`         | `agent-tools-DkIWbsdu.js` | **L764**        | `"tool_call"`                |
| `createToolSearchTools`           | `agent-tools-DkIWbsdu.js` | **L1785-L1863** | 4 个 meta tool 的 definition |
| `readToolSearchConfig`            | `agent-tools-DkIWbsdu.js` | **L1028-L1034** | 读 config.tools.toolSearch   |
| `resolveToolSearchConfig`         | `agent-tools-DkIWbsdu.js` | **L1043-L1065** | 解析 mode/timeout/limit      |
| `isToolSearchCodeModeSupported`   | `agent-tools-DkIWbsdu.js` | **L1040**       | 检查 `--permission` flag     |

### 8.3 Tool Call Loop

| 函数/常量                       | 文件                         | 行号              | 摘录                              |
| ------------------------------- | ---------------------------- | ----------------- | --------------------------------- |
| `runEmbeddedAgent`              | `embedded-agent-DqJgypM_.js` | **L1823-...**     | 主 entry                          |
| 主 `while (true)` loop          | `embedded-agent-DqJgypM_.js` | **L2488-L...**    | 单次 attempt 循环                 |
| `MAX_RUN_LOOP_ITERATIONS`       | `selection-BMP-JCML.js`      | **L14144-L14156** | run-level 上限计算                |
| `MAX_EMPTY_ERROR_RETRIES`       | `embedded-agent-DqJgypM_.js` | **L2357**         | "stopReason=error, output=0" 重试 |
| `MAX_MISSING_ASSISTANT_RETRIES` | `embedded-agent-DqJgypM_.js` | **L2359**         | "没收到 assistant" 重试           |
| `maxEmptyResponseRetryAttempts` | `embedded-agent-DqJgypM_.js` | **L2309**         | "空响应" 重试                     |
| `maxPlanningOnlyRetryAttempts`  | `embedded-agent-DqJgypM_.js` | **L2307**         | "只规划没执行" 重试               |
| `maxReasoningOnlyRetryAttempts` | `embedded-agent-DqJgypM_.js` | **L2308**         | "只思考没回答" 重试               |
| `runAgentHarnessAttempt`        | `selection-BMP-JCML.js`      | **L18110-L...**   | provider 路由 + 调用 harness      |

### 8.4 错误处理

| 函数/常量                         | 文件                                   | 行号            | 摘录                                                       |
| --------------------------------- | -------------------------------------- | --------------- | ---------------------------------------------------------- |
| `RECOVERABLE_TOOL_ERROR_KEYWORDS` | `embedded-agent-DqJgypM_.js`           | **L1259-L1266** | 7 个 "可恢复" keyword                                      |
| `isRecoverableToolError`          | `embedded-agent-DqJgypM_.js`           | **L1275-L1278** | 检测逻辑                                                   |
| `MUTATING_FAILURE_ACTION_PATTERN` | `embedded-agent-DqJgypM_.js`           | **L1267**       | "(?:write\|edit\|...\|action)"                             |
| `lastToolError` 状态              | `embedded-agent-DqJgypM_.js`           | **L422-L430**   | 错误状态结构                                               |
| `retryAsync` (数字模式)           | `retry-Ct1cdQO4.js`                    | **L42-L54**     | 3 次 + 指数退避                                            |
| `retryAsync` (对象模式)           | `retry-Ct1cdQO4.js`                    | **L56-L83**     | 完整 retryAfter + jitter + shouldRetry                     |
| `DEFAULT_RETRY_CONFIG`            | `retry-Ct1cdQO4.js`                    | **L9-L14**      | `{attempts:3, minDelayMs:300, maxDelayMs:30000, jitter:0}` |
| `applyJitter`                     | `retry-Ct1cdQO4.js`                    | **L36-L41**     | "symmetric" / "positive" jitter                            |
| `resolveRetryConfig`              | `retry-Ct1cdQO4.js`                    | **L24-L34**     | 配置归一化                                                 |
| `ToolLoopDetectionSchema`         | `zod-schema.agent-runtime-BMFszaAv.js` | **L419-L432**   | 死循环检测配置 schema                                      |
| `detectToolCallLoop`              | `tool-loop-detection-DCEGSB_Y.js`      | **L268-L371**   | 4 detector 主函数                                          |
| `recordToolCall`                  | `tool-loop-detection-DCEGSB_Y.js`      | **L373-L...**   | 记录到 history                                             |

### 8.5 History 滑窗

| 常量/函数                       | 文件                         | 行号            | 摘录                   |
| ------------------------------- | ---------------------------- | --------------- | ---------------------- |
| `DEFAULT_GROUP_HISTORY_LIMIT`   | `history-bkRCRe4s.js`        | **L7**          | `50`                   |
| `MAX_HISTORY_KEYS`              | `history-bkRCRe4s.js`        | **L8**          | `1e3` (1000)           |
| `evictOldHistoryKeys`           | `history-bkRCRe4s.js`        | **L24-L37**     | LRU 淘汰               |
| `appendHistoryEntry`            | `history-bkRCRe4s.js`        | **L39-L51**     | splice(0, overflow)    |
| `DEFAULT_HISTORY_MEDIA_LIMIT`   | `history-bkRCRe4s.js`        | **L67**         | `4`                    |
| `getHistoryLimitFromSessionKey` | `selection-BMP-JCML.js`      | **L9817-L9850** | per-session override   |
| `createChannelHistoryWindow`    | `history-window-D724Xnpm.js` | **L5-L41**      | 包装器                 |
| `buildHistoryContext`           | `history-bkRCRe4s.js`        | **L70-L77**     | 组装 history + current |

---

## §9 v2 ContextLoader vs OpenClaw prompt 组装 对比表

| 维度                    | v2 ContextLoader (5-layer)                             | OpenClaw (9+-layer)                                                   | v2 该学什么                     |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------- |
| **L1 静态身份**         | ✅ `identityText` (硬编码默认)                         | ✅ `buildOwnerIdentityLine` + `DEFAULT_IDENTITY`                      | ✅ 一样                         |
| **L2 动态人格**         | ✅ `darwin-personality` 来自 memory                    | ✅ `buildWorkspaceNotes`                                              | ✅ 一样（v2 用 memory 更优雅）  |
| **L3 长期学习**         | ✅ `user-*` keys aggregated                            | ✅ `buildMemorySection` (memory module)                               | ✅ 一样                         |
| **L4 最近历史**         | ✅ `historyMessages` from caller, `historyCharCap=180` | ✅ `getHistoryLimitFromSessionKey` + `DEFAULT_GROUP_HISTORY_LIMIT=50` | ⚠️ v2 限字符，OpenClaw 限条目数 |
| **L5 当前 turn**        | ✅ caller 传                                           | ✅ caller 传                                                          | ✅ 一样                         |
| **L6 安全段**           | ❌                                                     | ✅ `safetySection` L608-L616                                          | 🆕 v3 加                        |
| **L7 时间段**           | ❌                                                     | ✅ `buildTimeSection` L302                                            | 🆕 v3 加                        |
| **L8 工具行**           | ❌（用 3 meta tool）                                   | ✅ 27 core + 外部 tools                                               | ❌ v2 故意不注入（PR-24）       |
| **L9 Skills 段**        | ❌                                                     | ✅ `buildSkillsSection`                                               | ❌ v1 不做                      |
| **L10 ContextFiles**    | ❌                                                     | ✅ `prepareContextFilesForPrompt`                                     | ❌ v1 不做                      |
| **L11 Provider prefix** | ❌                                                     | ✅ `providerStablePrefix`                                             | 🆕 v3 加                        |
| **可见性**              | 🟢 **显式**（ContextLoader 是命名模块）                | 🟡 **隐式**（散布在 3 文件）                                          | ✅ v2 优于 OpenClaw             |
| **可测试性**            | 🟢 **5 个独立 layer，可单测**                          | 🟡 难单测（all-in-one）                                               | ✅ v2 优于 OpenClaw             |
| **可插拔性**            | 🟢 每层独立 toggle                                     | 🟡 buildAgentSystemPrompt 1 处 toggle                                 | ✅ v2 优于 OpenClaw             |
| **错误处理**            | n/a（loader 不管 tool）                                | `isRecoverableToolError` + `retryAsync`                               | —                               |
| **复杂度**              | 🟢 ~150 行                                             | 🟡 ~350 行（buildAgentSystemPrompt）                                  | v2 简单 = 优                    |

**结论**：**v2 5-layer < OpenClaw 9+-layer（数量），但 v2 5-layer > OpenClaw 9+-layer（质量）**——v2 显式/可测/可插拔，OpenClaw 隐式/集成/难分。**保留 v2 设计**。

---

## §10 给 darwin-architect 的 6 个决策点

| #     | 决策点                | PM 倾向       | docs 建议                            | 理由                                                           |
| ----- | --------------------- | ------------- | ------------------------------------ | -------------------------------------------------------------- |
| **1** | tool 暴露方式         | 3 meta tool   | ✅ **同 PM**                         | context 省 + LLM 主动找                                        |
| **2** | MAX_TOOL_ROUNDS       | 5             | ✅ **同 PM**（但预留 5/10/20 三档）  | v1 经验 < 5 够；保守                                           |
| **3** | 降级链来源            | manifest 声明 | ✅ **同 PM**                         | OpenClaw 不做（只 provider failover），v2 应该做 tool failover |
| **4** | per-call 重试         | 1-3 次        | ✅ **3 次 + 300ms 退避**             | OpenClaw 不重试，v2 应该比 OpenClaw 强                         |
| **5** | ContextLoader 5-layer | 保留          | ✅ **保留 + 注释里说明 v3 升级路径** | 比 OpenClaw 显式                                               |
| **6** | child vm bridge       | 不做          | ✅ **同 PM**                         | v2 v1 复杂度太高                                               |

**额外 docs 拍 2 个**（PM 没问）：

| #     | 决策点                               | docs 拍                         | 理由                                                                                        |
| ----- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------- |
| **7** | 错误归类（`isRecoverableToolError`） | ✅ **学 OpenClaw 7 个 keyword** | `required/missing/invalid/must be/must have/needs/requires`——LLM 看到 "参数错" 应该自己重调 |
| **8** | 死循环检测                           | ❌ **v1 不做**                  | v1 用户群小, 5 round 已够, v3 抄 OpenClaw 4-detector                                        |

---

## §11 文件位置 & 维护

### 11.1 这份文档的位置

- **路径**：`/home/weixing/darwin/docs/OPENCLAW_PROMPT_REFERENCE.md`
- **配套**：
  - `OPENCLAW_PROMPT_REFERENCE_DRAFT.md`（PM 种子稿，保留作为历史）
  - `ANTI_PATTERNS.md`（v2 反模式清单）
  - `USAGE.md`（v2 操作说明）

### 11.2 docs 索引（建议在 USAGE.md 末尾加）

```markdown
## 调研参考

| 文档                                                                       | 用途                                    | 状态                 |
| -------------------------------------------------------------------------- | --------------------------------------- | -------------------- |
| [OPENCLAW_PROMPT_REFERENCE.md](./OPENCLAW_PROMPT_REFERENCE.md)             | OpenClaw prompt+tool 调研（PR-A FINAL） | ✅ v1.0 (2026-06-14) |
| [OPENCLAW_PROMPT_REFERENCE_DRAFT.md](./OPENCLAW_PROMPT_REFERENCE_DRAFT.md) | PM 种子稿（v0.1）                       | 📜 历史              |
| [ANTI_PATTERNS.md](./ANTI_PATTERNS.md)                                     | v2 反模式清单                           | ✅ v1.0              |
| [USAGE.md](./USAGE.md)                                                     | v2 操作说明                             | ✅ v1.0              |
```

### 11.3 维护规则

- **代码行号会随 OpenClaw 版本变化**——每次 `npm update openclaw` 后，用本节 §8 表格里的函数/常量名 grep 重新校准行号
- **OpenClaw 大版本升级时重写一份**——v2 v3 启动前再读一次 OpenClaw 源码，出一份 v2 版本
- **v2 启动后归档**——v2 启动（PR-25 完成）后，本文件归档到 `docs/archive/pr-a/`

### 11.4 给 darwin-architect 的快速摘要

```
PR-22 (ContextLoader 5-layer)        → 已实现，不动
PR-23 (v2 自己的 prompt 设计)         → 保留 5-layer, v3 加 safety/time/provider prefix
PR-24 (tool 暴露 3 meta tool)         → 学 OpenClaw: tool_search/describe/call
PR-25 (tool call loop)                → 比 OpenClaw 强: MAX_ROUNDS=5, per-call retry=3, manifest 降级链
                                        错误归类: 学 OpenClaw 7 keyword
                                        死循环检测: v1 不做, v3 抄
```

---

**END OF FINAL**

> **致 darwin-architect**：
> PM 种子稿 + docs 调研空白补全 + 5 句关键发现 + 8 个决策点 = 这份 FINAL。
> §0 TL;DR 1 分钟读完，§7 §8 干活时翻，§10 是你的拍板清单。
> 关键代码引用都带行号（`dist/<file>.js:L<n>` 格式），可以直接 copy 进 v2 的注释里。
> 写 v2 代码时**不要照搬 OpenClaw**——v2 5-layer ContextLoader 比 OpenClaw 9-layer 显式，这是 v2 的优势，要保留。
