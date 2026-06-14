# OpenClaw Prompt + Tool 参考（PM 调研种子稿）

> **状态**：PM 调研种子稿（v0.1, 2026-06-14）
> **目的**：调研 OpenClaw 怎么"拼 prompt + 跑 tool call"，给 v2 骨架对齐用
> **作者**：PM（Hermes）
> **用法**：darwin-docs 拿这份稿 → 出 FINAL → darwin-architect 拿 FINAL 设计 v2 PR-23/24/25

---

## 1. 调研方法

- OpenClaw 源码：`/home/weixing/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/`
- 关键文件：
  - `dist/runtime-llm.runtime-*.js` — LLM runtime + buildSystemPrompt + buildMessages
  - `dist/agent-tools-*.js` — tool 体系
  - `dist/attempt-execution-*.js` — tool call loop
  - `dist/chat-*.js` — chat 流程
- 版本：OpenClaw 2026.5.28 (e932160)

---

## 2. OpenClaw 的 prompt 组装（**关键发现**）

### 2.1 buildSystemPrompt（**极简**）

```js
function buildSystemPrompt(params) {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages.filter((m) => m.role === 'system').map((m) => normalizeOptionalString(m.content)),
  ].filter((s) => Boolean(s));
  return segments.length > 0 ? segments.join('\n\n') : void 0;
}
```

**只做一件事**：把 systemPrompt（顶层） + 任何 role=system 的 message.content **简单 join**。

### 2.2 buildMessages

```js
function buildMessages(params) {
  return params.request.messages
    .filter((m) => m.role !== 'system')
    .map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content, timestamp: now }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: m.content }],
            api,
            provider,
            model,
            usage,
            stopReason,
            timestamp,
          },
    );
}
```

**也只做一件事**：过滤掉 system + 给 user/assistant 消息补 timestamp/usage 元数据。

### 2.3 关键洞察（PM 拍）

**OpenClaw 不主动"拼人格+记忆+技能+工具"**。它假设 caller（session manager / channel adapter）已经把所有 system messages 塞进 messages 数组了，buildSystemPrompt 只是把数组里所有 system 消息 join 起来。

**真正的"组装"是 caller 干的**——这是一个重要的设计选择：

| 选项               | OpenClaw 做法   | v2 ContextLoader 做法         |
| ------------------ | --------------- | ----------------------------- |
| **谁负责组装**     | caller（上层）  | core/context-loader.js 主动拼 |
| **组装深度**       | 浅（简单 join） | 深（5-layer L1-L5）           |
| **谁负责数据来源** | caller 自己取   | ContextLoader 自己读          |

**v2 的做法更"主动"**——ContextLoader 是显式的中间层，知道人格在哪、记忆在哪、技能在哪、当前历史在哪。这是 v2 优于 OpenClaw 的地方，**不要照搬 OpenClaw 的浅组装**。

---

## 3. OpenClaw 的 tool 体系

### 3.1 三个 meta tool

```js
const TOOL_SEARCH_CODE_MODE_TOOL_NAME = 'tool_search_code';
const TOOL_SEARCH_RAW_TOOL_NAME = 'tool_search';
const TOOL_DESCRIBE_RAW_TOOL_NAME = 'tool_describe';
const TOOL_CALL_RAW_TOOL_NAME = 'tool_call';
```

**OpenClaw 暴露给 LLM 的是 3 个 meta 工具**（+ 1 个 code 模式）：

- `tool_search` — 找可用工具（按 name 模糊匹配）
- `tool_describe` — 拿工具 schema
- `tool_call` — 真正调工具

**这是个聪明的设计**：LLM 看到的工具列表 = 3 个 meta tool，**不是全部工具的 schema**。这避免了"工具太多 context 爆炸"的问题。LLM 想用哪个工具，先 `tool_search("weather")` → `tool_describe("get_weather")` → `tool_call("get_weather", {city: "北京"})`。

### 3.2 child vm bridge

`TOOL_SEARCH_CODE_MODE_CHILD_SOURCE` 是一个独立的 Node VM，沙箱执行 LLM 写的 JS 代码。LLM 在调工具前可以先在沙箱里跑代码，组合数据再传给 tool_call。

**这是 OpenClaw 高级特性，v2 v1 阶段可以不做**。

### 3.3 v2 应该学 / 不学什么

| OpenClaw 特性                           | v2 该学吗   | 原因                                                                                                                                      |
| --------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **3 meta tool 设计**                    | ⭐ **要学** | 解决"工具多 context 爆炸"。v2 也应该让 LLM 通过 `tool_search` / `tool_describe` / `tool_call` 间接访问工具，而不是把全部 schema 塞 prompt |
| **child vm bridge**                     | ❌ 不做     | v3+ 再说，v2 v1 阶段只做直接 tool_call                                                                                                    |
| **tool search/describe 走 prompt 注入** | ⭐ **要学** | PR-24 的核心                                                                                                                              |
| **schema 不注入 prompt**                | ⭐ **要学** | 配合 meta tool 设计                                                                                                                       |

---

## 4. OpenClaw 的 tool call loop（**核心**）

> 4.1 详细伪代码

OpenClaw 的 attempt-execution 流程：

```
attempt:
  准备 messages 数组（caller 把 system 消息塞好）
  loop:
    resp = LLM(messages, tools=[3 meta tools])

    if resp 是 text:
      return text  # 答完了

    if resp 是 tool_call:
      # OpenClaw 的处理：
      result = 解析 tool_call(JSON 格式的 name + arguments)

      if 工具不存在:
        emit error event → 告诉 LLM "工具不存在"
        continue

      if 工具存在:
        try:
          result = 实际执行(tool_name, args)
        catch err:
          emit error event
          # 不重试，直接告诉 LLM 失败
          continue
        # 把结果塞回 messages
        messages.push({role:"tool", content:result})
        continue
```

### 4.2 v2 跟 OpenClaw 的差异（PM 拍）

| 维度           | OpenClaw                         | v2 现状 | v2 应该改吗                  |
| -------------- | -------------------------------- | ------- | ---------------------------- |
| **循环上限**   | 隐式（OpenClaw 没明确说）        | 无      | ✅ 加 `MAX_TOOL_ROUNDS=5-10` |
| **错误处理**   | 工具失败 = 告诉 LLM 失败，不重试 | 无      | ✅ 加重试（网络错 1-3 次）   |
| **降级**       | 无显式降级链                     | 无      | ✅ 加降级（主工具挂了换备）  |
| **死循环保护** | 无显式                           | 无      | ✅ MAX_TOOL_ROUNDS 即可      |

---

## 5. v2 实际需要做的事（给 darwin-architect 拍）

### 5.1 PR-24（工具 list 注入）— **OpenClaw 风格**

**不要**直接把全部工具 schema 塞 prompt。**要**塞 3 个 meta tool：

- `tool_search(query)` — 找工具
- `tool_describe(name)` — 拿 schema
- `tool_call(name, args)` — 调工具

### 5.2 PR-25（tool call loop）— **比 OpenClaw 强**

```
loop max 5 rounds:
  resp = LLM(messages, tools=[3 meta])
  if resp.text: return resp.text
  if resp.tool_call:
    name, args = parse(resp)

    if name == "tool_search":
      result = searchTools(args.query)
    elif name == "tool_describe":
      result = describeTool(args.name)
    elif name == "tool_call":
      try:
        result = executeTool(args.name, args.args)
        # 重试：网络错 1-3 次
        for i in 1..3:
          try: result = executeTool(...); break
          except NetworkError: continue
        # 降级：主工具挂了换备
        if failed: result = fallbackTool(args.name, args.args)
      except ParamError:
        result = "参数错误，请重新调用"

    messages.push({role:"tool", content:result})
    continue
```

### 5.3 PR-25 的 5 条边界

1. **网络错** → 重试 1-3 次（指数退避）
2. **业务错**（404 / 400）→ 不重试，告诉 LLM 失败
3. **工具不存在** → 告诉 LLM "工具不存在"
4. **参数错** → 告诉 LLM "参数错"，让它重调
5. **降级链用尽** → 老实告诉用户"我查不了"

---

## 6. PM 提的 3 个开放问题（给 darwin-architect 拍）

### Q1: tool 暴露是"全 schema 注入"还是"3 meta tool"？

- **3 meta tool**（OpenClaw 风格）：context 省，LLM 主动找工具
- **全 schema 注入**：context 费，LLM 直接看
- **PM 倾向 3 meta tool**（更优雅）

### Q2: tool call loop 的 MAX_ROUNDS 设多少？

- 5：保守（节省 token）
- 10：宽松（复杂任务）
- **PM 倾向 5**（v1 经验：v1 多次 tool call < 5 就够）

### Q3: 降级链的来源？

- 工具 manifest 里声明 `fallback: [tool_b, tool_c]`
- v2 plugin loader 加这个字段
- **PM 倾向 manifest 声明**（跟 OpenClaw 一致）

---

## 7. 文件清单（PM 给 darwin-docs 的）

写 FINAL 时必须覆盖：

- [ ] §1 OpenClaw 怎么拼 prompt
- [ ] §2 OpenClaw 怎么暴露 tool
- [ ] §3 OpenClaw 怎么跑 tool call loop
- [ ] §4 OpenClaw 怎么处理错误
- [ ] §5 v2 怎么对齐（PR-23/24/25 各对应什么）
- [ ] §6 关键代码引用（带行号）
- [ ] §7 跟 v2 ContextLoader 的对比表

---

## 8. 调研待补充（PM 没时间做的）

- [ ] OpenClaw 错误重试的精确逻辑（待读 attempt-execution 全文）
- [ ] OpenClaw tool 降级链的来源（待查 manifest schema）
- [ ] OpenClaw history 滑窗策略（v2 L4 = 180 字符/turn 是怎么定的）

---

**END OF DRAFT**

> 给 darwin-docs 的 prompt：拿这份稿 → 补 §8 调研空白 → 出 FINAL（不少于 800 行）→ 写到 `darwin/docs/OPENCLAW_PROMPT_REFERENCE.md`
