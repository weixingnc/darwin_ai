# v2 PR-26 — OpenClaw SKILL L1+L2 兼容层

> 设计稿 v0.1（2026-06-15）· darwin-architect 响应 Hermes PM PR-Design 03
> 对齐：[OPENCLAW_PROMPT_REFERENCE.md](./OPENCLAW_PROMPT_REFERENCE.md) §3.5/§8.2 + [PR_DESIGN_21_SKILL_LOADER.md](./PR_DESIGN_21_SKILL_LOADER.md) §10 + [PR_DESIGN_23_24_25.md](./PR_DESIGN_23_24_25.md)
> 前置：PR-21a `12a29ff` + PR-21b `b98a69f` + PR-23 `829629b` · 后续：PR-27 · 约束：单文件 < 1000 / 单 PR < 500

## §0 TL;DR（5 句拍板）

1. **拆 2 个 PR**：PR-26a `core/openclaw-skill-adapter.js`（~150）+ PR-26b `core/skill-matcher-v2.js`（~120）——各 < 500 行；**不动** 任何 PR-21/22/23/24/25 已落地的 core 文件。
2. **OpenClaw AgentSkills → Darwin SkillEntry**：`name` 必填 + `description` 推断 trigger + `metadata.openclaw.darwinTriggers` 显式覆盖 —— **L1**（无 description / 无 metadata）= 退化到 `name` 单 trigger；**L2**（有 description 或 metadata）= 从 description 提取 trigger。
3. **triggerType metadata 兑现**（PR-21 review advisory 1）：PR-26b 新增 `matchSkillsV2` 纯函数读 `entry.triggerType` 4 选 1；PR-23 `matchSkills` 冻结，**PR-27 集成时再切换**（一行 import 替换）。
4. **错误不致命**：OpenClaw 格式不兼容 = warn + skip，**darwin 永不为兼容层崩**。
5. **单文件 < 1000 / 单 PR < 500 红线** —— PR-26a + PR-26b **各** < 200 行 code + < 100 行 tests。

---

## §1 OpenClaw SKILL 真实格式（来自 `dist/skills/.../SKILL.md`）

> **关键差异**：OpenClaw 用 **LLM 驱动触发**（`description` 进 prompt, LLM 决定是否调），Darwin v2 用 **deterministic 触发**（`triggers: string[]` 子串匹配）。PR-26 必须把 LLM 触发**重写**为 deterministic。

### 1.1 L1（轻量，仅 `name`）

```yaml
--- name: weather ---  # 简短正文
```

→ triggers = `[name]`, triggerType = `'substring'`, source = `'openclaw-l1'`。

### 1.2 L2（完整，含 `description` + `metadata.openclaw`）

```yaml
name: weather
description: 'Current weather and forecasts with wttr.in via curl...'
metadata: { openclaw: { emoji: ☔, requires: { bins: ['curl'] }, install: [...] } }
```

→ triggers 从 `description` 推断（见 §3），triggerType 默认 `'substring'`，source = `'openclaw-l2'`，`metadata.openclaw` 整块存 `entry.openclawMetadata`（**原样保留**，供 PR-27 集成时用）。

### 1.3 L1 vs L2 检测

| 条件                                                       | 判定           |
| ---------------------------------------------------------- | -------------- |
| 缺 `description` 且缺 `metadata.openclaw`                  | L1             |
| 有 `description` **或** 有 `metadata.openclaw`（任一即可） | L2             |
| 有 `description` 但空字符串 / 只有空白                     | L1             |
| `metadata.openclaw` 非对象（数组 / 字符串）                | warn + 降级 L1 |

### 1.4 frontmatter 字段处理清单

| 字段类别                                                                       | PR-26 怎么做                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `name`                                                                         | ✅ 必填，映射 v2 `name`（沿用 PR-21 `NAME_RE` ≤ 32） |
| `description`                                                                  | ✅ L2 trigger 源 + v2 `hint`（限 2000 字）           |
| `homepage` / `metadata.openclaw.{emoji,requires,install,os,primaryEnv,...}`    | 🟡 整块存 `entry.openclawMetadata`（PR-27 用）       |
| `metadata.openclaw.darwinTriggers` / `darwinTriggerType` / `darwinPriority` 🆕 | 🆕 v2 扩展（triggers 覆盖 / type / priority 0-100）  |
| `user-invocable` / `disable-model-invocation` / `allowed-tools` / `license`    | ❌ 忽略（v2 无对应语义）                             |
| 其他未知字段                                                                   | 🟡 忽略 + 不 warn（OpenClaw 演进不破坏 v2）          |

---

## §2 字段映射表（OpenClaw YAML → Darwin SkillEntry）

> **目标**：adapter 输出的 `SkillEntry` 兼容 PR-21 `registerSkill`（`skill-loader.js:289-318`），PR-23 `_firstMatchingTrigger` 零改动可消费。

| Darwin SkillEntry 字段      | OpenClaw 来源                                                | 必填            |
| --------------------------- | ------------------------------------------------------------ | --------------- |
| `name`                      | `name`                                                       | ✅              |
| `version`                   | 无 → `'0.0.0'`（OpenClaw 无 version 概念）                   | ❌              |
| `triggers`                  | L1=`[name]` / L2=derive(description) / darwinTriggers 覆盖   | ❌（默认 `[]`） |
| `triggerType`               | L1/L2 默认 `substring` / darwinTriggerType 覆盖              | ❌              |
| `hint` / `systemPromptHint` | `description`（限 2000 字）—— PR-21 双键技巧一次写两键       | ❌（默认 `''`） |
| `priority`                  | `darwinPriority`（0-100） / 默认 50，越界 clamp              | ❌              |
| `source`                    | `'openclaw-l1'` / `'openclaw-l2'`（自动注入）                | ✅              |
| `path`                      | OpenClaw 文件绝对路径                                        | ✅              |
| `body`                      | frontmatter 后正文（限 50KB，PR-21 同款 truncate）           | ❌              |
| `openclawMetadata` 🆕       | `metadata.openclaw` 整块 —— **新字段**，PR-23 不读，PR-27 用 | ❌              |

**关键不变量**：adapter 输出 entry 通过 PR-21 `registerSkill` 注册 → PR-23 `matchSkills` 读 `entry.triggers` / `entry.systemPromptHint` 零修改可消费。`openclawMetadata` 是 deadweight（写但不消费）。

---

## §3 触发器（triggers）推断规则

**3 种来源 + 1 兜底**：

| 来源                              | 规则                                                                                                                       | 示例 / 约束                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **L1**（`[name]`）                | `triggers: [name.toLowerCase()]`                                                                                           | name 格式错 → `{ok:false, errorCode:'invalid_name'}`                   |
| **L2**（derive from description） | ① 去引号 → ② 首句（`.!?` / `。！？` 之前）→ ③ 截 ≤ 64 字 → ④ 空格/中文标点切，取前 4 token → ⑤ 全小写 → ⑥ 空 = fallback L1 | 英文首句 → 4 token；中文 → 1 条；空字符串 → L1 fallback                |
| **darwinTriggers**（显式覆盖）    | 完全跳过推断                                                                                                               | 约束同 PR-21 `parseTriggers`（≤ 64 字/条、最多 100 条、空字符串 skip） |
| **兜底**（推断后 `[]`）           | warn + 允许注册（`matchSkills` 见到 `triggers:[]` 自然 skip）                                                              | —                                                                      |

**冲突降级**：`darwinTriggers` 全是非 string/空 → 降级 L2；部分无效 → 过滤后继续。**永不拒收**（除 L1 name 格式错）。

---

## §4 triggerType metadata 兑现（PR-21 review advisory 1）

### 4.1 现状

PR-21 把 `triggerType` 写进 `entry.triggerType`（`core/skill-loader.js:219`），但 PR-23 `_firstMatchingTrigger`（`core/skill-registry.js:96-110`）**不读**这个字段 —— 只做 `needle.includes(trigger.toLowerCase())`。**触发类型目前是 metadata-only**。

### 4.2 PR-26b 解法（**不动** skill-registry.js）

新增 `core/skill-matcher-v2.js` 导出 `matchSkillsV2({text, registry, max})`：

```text
matchSkillsV2({text, registry, max=2}):
  for [name, entry] in registry:   // insertion order
    if matches.length >= max: break
    triggerHit = matchByTriggerType(entry, text)
    if triggerHit: matches.push({...matcherVersion:'v2'})
  return matches
```

**4 个 `_matchBy*` 实现**（PR-21 §3.1 语义 + advisory 1 兑现）：

| type             | 匹配逻辑                                                   | 失败 fallback                                 |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `exact`          | `text.trim() === trigger`                                  | warn + skip                                   |
| `substring`      | `text.toLowerCase().includes(trigger.toLowerCase())`       | 默认路径                                      |
| `regex`          | `try { new RegExp(trigger).test(text) } catch → fallback`  | compile 失败 → substring + warn               |
| `command-prefix` | `text.trim().startsWith(trigger)`（trigger 必须 `/` 开头） | trigger 不以 `/` 开头 → 该条 substring + warn |

`matchSkillsV2` 是 `matchSkills` 的**严格超集**（substring 路径完全一致），**PR-27 集成时一行 import 替换**。

### 4.3 ⚠️ 冲突点（architect 自报，PM 请确认）

任务原文说"**同时 PR-23 matcher 升级**"，但 `禁止 ❌ 改 core/skill-registry.js`（PR-23 sha `829629b`）。

**PR-26 方案**：**不**改 skill-registry.js，**新建** `core/skill-matcher-v2.js`。**PR-23 `matchSkills` 仍是默认**（L6 零回归）；**PR-27 集成**时把 L6 调用从 `matchSkills` 切到 `matchSkillsV2`（一行 import diff）。

效果：① 兑现 advisory 1（triggerType 实际生效）；② 不破 PR-23/24/25 冻结；③ 集成风险留给 PR-27（按 v1 教训"切函数需 integration test"）。**若 PM 坚持 PR-26 改 skill-registry.js**，请明示；architect 默认按"禁止"执行。

### 4.4 OpenClaw 描述到 triggerType 的隐式映射（**仅在 darwinTriggerType 缺省时生效**）

| OpenClaw 特征                                   | adapter 推断 triggerType           |
| ----------------------------------------------- | ---------------------------------- |
| L1 / 无 darwinTriggerType                       | `'substring'`                      |
| `description` 以 `/` 开头                       | `'command-prefix'`                 |
| `description` 含正则字符（`*` `^` `$` `(` `\`） | `'regex'` + warn                   |
| `description` 是单 token（无空格 / 标点）       | `'exact'`（避免误匹配）            |
| 显式 `darwinTriggerType` 覆盖                   | 用显式值（validate 同 PR-21 §5.1） |

---

## §5 API 契约

### 5.1 PR-26a — `core/openclaw-skill-adapter.js`（导出 3 函数，**永不抛**）

```text
parseOpenClawSkillFile(filePath, content) -> SkillEntry | null
  // 纯函数; frontmatter 切分 + YAML + 字段映射 + 推断 triggers/triggerType
  // 损坏（缺 name / YAML 失败 / 推断后空）→ null

adaptOpenClawSkills(skillsDir, registry) -> AdaptResult
  // AdaptResult = { loaded, skipped:[{path,reason}], total, l1Count, l2Count }
  // skillsDir 不存在 → 返空 result

isOpenClawSkillContent(content) -> boolean
  // 启发式: 含 frontmatter + `name` 但**没** v2 专属字段
  //   (version/triggers/triggerType/priority) → true
  // PR-21 loader (PR-27) 用此 decide "走 v2 parse 还是 OpenClaw adapter parse"
```

### 5.2 PR-26b — `core/skill-matcher-v2.js`（导出 2 函数，**永不抛**）

```text
matchSkillsV2({text, registry, max=2}) -> SkillMatch[]
  // matchSkills 严格超集; 读 entry.triggerType
  // SkillMatch = {name, triggerHit, systemHint, source, triggerType, matcherVersion:'v2'}
  // bad input → []

matchByTriggerType(entry, text) -> string | null
  // 单条 entry 匹配; 返回命中的 trigger 原文（非 lowercase 后）
```

### 5.3 错误码（沿用 PR-21 + 新增 2 个，**不** 改 PR-21/24 字典）

| code                                        | 触发                                                 | 谁产出  |
| ------------------------------------------- | ---------------------------------------------------- | ------- |
| `invalid_name`（新）                        | OpenClaw `name` 不匹配 `NAME_RE` 或 > 32 字          | adapter |
| `openclaw_compat_failed`（新）              | 其他 OpenClaw 格式不兼容（YAML 崩 / frontmatter 缺） | adapter |
| `parse_failed` / `read_error`（沿用 PR-21） | 通用 parse / IO 失败                                 | caller  |

`AdaptResult.skipped[].reason` 是上述 4 个之一。**不引入** `TOOL_*`（PR-24/25 域）。

---

## §6 错误边界

### 6.1 单文件损坏 → 不致命（loaded 列 ✅/❌，reason 列)

| 损坏类型                                    | 处理                      | loaded?                                |
| ------------------------------------------- | ------------------------- | -------------------------------------- |
| 缺 frontmatter / frontmatter 空 / YAML 失败 | warn + skip               | ❌ `openclaw_compat_failed`            |
| 缺 `name` / `name` 格式错                   | warn + skip               | ❌ `invalid_name`                      |
| `darwinTriggers` 全是非 string / 空         | warn + 降级 L2 推断       | ✅                                     |
| `darwinTriggers` 部分无效                   | warn + 过滤               | ✅                                     |
| `darwinTriggerType` 非法                    | warn + 降级 `'substring'` | ✅                                     |
| `darwinPriority` 越界 / 非数字              | warn + clamp              | ✅                                     |
| `description` > 2000 字                     | warn + 截断               | ✅                                     |
| 推断 + 兜底后 `triggers` 仍为 `[]`          | warn + 允许注册           | ✅                                     |
| 同一 name 重复 + 新 priority ≤ 旧           | warn + skip（保留旧）     | ❌ `duplicate_lower_priority`（PR-21） |

### 6.2 目录 / matcher 错误

| 情况                                                      | 处理                                            |
| --------------------------------------------------------- | ----------------------------------------------- |
| `skillsDir` 不存在 / 全损坏 / 0 个 `.md`                  | warn + 返空 result —— darwin 仍可启动           |
| `adaptOpenClawSkills` 自身抛（不应该）                    | bug, adapter 必须 fix（**不靠 catch 兜**）      |
| `text` 空 / `registry` 缺 / `triggerType` 非法            | 返 `[]` / 视为 substring（matcher-v2 向后兼容） |
| `regex` 编译失败 / `command-prefix` trigger 不以 `/` 开头 | warn + 降级 substring（**仅该 trigger**）       |

**关键不变量**：**darwin 进程永不因 OpenClaw 兼容层崩坏**（沿用 PR-21 §5.3 + 加固）。

---

## §7 PR 拆分（单 PR ≤ 500 行红线 → 拆 2 PR；总计 ~450 行，单 PR 都 < 200）

| PR                | 文件                                                          | 行数 | 前置          |
| ----------------- | ------------------------------------------------------------- | ---- | ------------- |
| **PR-26a**        | `core/openclaw-skill-adapter.js`                              | ~150 | PR-21a merged |
|                   | `tests/core/openclaw-skill-adapter.test.js`（12 unit）        | ~100 | PR-21a merged |
| **PR-26b**        | `core/skill-matcher-v2.js`（4 `_matchBy*` + `matchSkillsV2`） | ~120 | PR-26a merged |
|                   | `tests/core/skill-matcher-v2.test.js`（8 unit）               | ~80  | PR-26a merged |
| **PR-27**（后续） | `tests/integration/openclaw-skill-e2e.test.js`（端到端）      | ~150 | PR-26b merged |

PR-26a 内容 = 3 函数（`parseOpenClawSkillFile` / `adaptOpenClawSkills` / `isOpenClawSkillContent`）。

**不动**：`core/skill-registry.js`（PR-23 sha `829629b`）/ `core/skill-loader.js`（PR-21a sha `12a29ff`）/ `core/skill-watcher.js`（PR-21b sha `b98a69f`）/ `core/context-loader.js`（PR-22）/ `core/tool-catalog.js`（PR-24）/ `core/tool-call-loop.js`（PR-25）/ `docs/PR_DESIGN_23_24_25.md`（只读）/ `docs/PR_DESIGN_21_SKILL_LOADER.md`（只读）。PR-27 加载入口见 §10.1。

---

## §8 测试规约

### 8.1 Unit（`tests/core/openclaw-skill-adapter.test.js`，12 case）

1-2. 缺 frontmatter / frontmatter 空 → null
3-4. 缺 `name` / name 含大写 → null + reason `openclaw_compat_failed` / `invalid_name` 5. L1 最小（仅 `name`）→ source = `'openclaw-l1'`, triggers = `[name]` 6. L2 完整 → source = `'openclaw-l2'`, openclawMetadata 完整保留
7-8. L2 description 英文首句 → 4 token / 中文 → 单条 9. `darwinTriggers` 显式覆盖 → 跳过 L2 推断 10. `darwinTriggerType: 'command-prefix'` → triggerType 正确 11. `description` 推断到空 → fallback L1 → 仍空 → warn + 仍注册（triggers=[]）12. `metadata.openclaw` 非对象 → warn + 当 L1 + openclawMetadata 缺省

### 8.2 Integration（`tests/core/openclaw-skill-adapter.integration.test.js`，6 case，**PR-26a 包含**）

1. `adaptOpenClawSkills(realDir, registry)` 加载 3 OpenClaw SKILL.md → registry.size === 3
2. 混合目录（1 v2 + 2 OpenClaw）→ 各自正确加载（v2 由 caller 单独调 PR-21 loadAll，PR-26a 只负责 OpenClaw）
3. 损坏文件 → `skipped[].reason ∈ {openclaw_compat_failed, invalid_name, read_error}`
4. l1Count + l2Count 准确
5. skillsDir 不存在 → 返空 + 不抛
6. OpenClaw 真实 SKILL.md fixture（`tests/fixtures/openclaw/weather/SKILL.md`）端到端

### 8.3 matcher-v2 Unit（`tests/core/skill-matcher-v2.test.js`，8 case）

1-4. 4 个 type 各 1 命中（`exact`/`substring`/`regex`/`command-prefix`）5. `text: ""` / `text: null` / `registry` 缺 → `[]` 6. `entry.triggerType` 缺省 → 等价 substring（**向后兼容 PR-23 contract**）7. `entry.triggerType: 'invalid'` → warn + 降级 substring 8. `regex` 编译失败 / `command-prefix` trigger 不以 `/` 开头 → warn + 降级（**仅该 trigger**）9. `matcherVersion: 'v2'` 字段存在 10. 1000 entry registry 上 < 10ms（perf sanity）

---

## §9 行号对照

### PR-26a — `core/openclaw-skill-adapter.js`（预计 ~150 行）

| 函数 / 区块                                                 | 预期行号  | 行数 |
| ----------------------------------------------------------- | --------- | ---- |
| 模块注释 + 8 const（`OPENCLAW_L1='openclaw-l1'` 等）        | L1-L25    | 25   |
| `_parseYaml`（PR-21 风格最小 YAML，支持 metadata 嵌套对象） | L26-L75   | 50   |
| `_extractFrontmatter`（复用 PR-21 风格正则）                | L76-L95   | 20   |
| `_detectLevel`（L1 vs L2）                                  | L96-L120  | 25   |
| `_inferTriggersFromDescription`（§3.2 推断）                | L121-L160 | 40   |
| `_mapTriggerType`（§4.4 隐式 + §3.3 显式）                  | L161-L185 | 25   |
| `parseOpenClawSkillFile`（顶层编排 + 字段映射）             | L186-L240 | 55   |
| `adaptOpenClawSkills`（扫目录 + 批量 register）             | L241-L275 | 35   |
| `isOpenClawSkillContent`（启发式探测）                      | L276-L300 | 25   |

### PR-26b — `core/skill-matcher-v2.js`（预计 ~120 行）

| 函数 / 区块                                                               | 预期行号  | 行数 |
| ------------------------------------------------------------------------- | --------- | ---- |
| 模块注释 + 4 const（`TT_SET` 沿用 PR-21）                                 | L1-L15    | 15   |
| `_matchExact` / `_matchSubstring` / `_matchRegex` / `_matchCommandPrefix` | L16-L75   | 60   |
| `matchByTriggerType`（顶层 dispatch）                                     | L76-L95   | 20   |
| `matchSkillsV2`（遍历 + 截到 max + 返回 SkillMatch[]）                    | L96-L130  | 35   |
| `matcherVersion: 'v2'` 标识                                               | L131-L140 | 10   |

### 引用（已有文件，PR-26 不动，PR-27 才接）

| 现有函数 / 字段                        | 文件                            | PR-26 怎么用                                                         |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `parseSkillFile(filePath, content)`    | `core/skill-loader.js:183-225`  | **不调**；PR-26 独立路径，PR-27 在 `loadAll` 末尾追加一行            |
| `registerSkill(registry, entry)`       | `core/skill-loader.js:289-318`  | `adaptOpenClawSkills` 调此 API                                       |
| `SKILL_MATCH_SOURCE_REGISTRY`          | `core/skill-registry.js:25`     | `matchSkillsV2` 的 `source` 字段也用这个常量                         |
| `matchSkills({text, registry, max})`   | `core/skill-registry.js:57-70`  | **不调**；`matchSkillsV2` 是独立导出                                 |
| `_firstMatchingTrigger(entry, needle)` | `core/skill-registry.js:96-110` | **不调**；`matchByTriggerType` 是 4 个独立 `_matchBy*`               |
| `name` 正则 / `MAX_NAME` / `MAX_HINT`  | `core/skill-loader.js:7-19`     | adapter 顶部 `// see PR-21 L7-L19` 引用注释（不 import `_internal`） |

---

## §10 PR-27 集成预留

### 10.1 PR-27 必做的 3 个一行 diff

```diff
# 1+2. core/skill-loader.js loadAll() + core/skill-watcher.js apply() — 末尾追加
+ import { isOpenClawSkillContent, parseOpenClawSkillFile } from './openclaw-skill-adapter.js';
+ if (isOpenClawSkillContent(content)) entry = parseOpenClawSkillFile(filePath, content);

# 3. core/skill-registry.js — 切换（**PR-27 唯一允许改 skill-registry 的地方**）
+ import { matchSkillsV2 } from './skill-matcher-v2.js';
```

> **PR-27 切函数是真正的"PR-23 升级"**——PR-26 只 ship 工具，PR-27 才动 skill-registry.js 那**一行** import。

### 10.2 PR-27 集成测试（`tests/integration/openclaw-skill-e2e.test.js`，~150 行 / 6 case）

1. **真 OpenClaw fixture 端到端**：复制 `~/.nvm/.../openclaw/skills/weather/SKILL.md` → 加载 → matcher-v2 触发 → L6 注入 hint
2. **混合目录**：v2 + OpenClaw 同 prefix，priority 排序后 L6 注入顺序正确
3. **triggerType 真生效**：`darwinTriggerType: 'command-prefix'` 的 OpenClaw skill → "/weather" 命中，"weather" 不命中
4. **错误不致命**：损坏的 OpenClaw SKILL.md → warn + 其他 skill 仍工作
5. **热更新**：watcher 检测到 `weather` 目录改名 → unregister → 改名回来 → re-register
6. **性能 sanity**：1000 skill registry + 100 turn benchmark，matcher-v2 < 50ms

### 10.3 PR-27 不做

不实现 `fallback` 链（PR-25 tool 层做）/ 不实现 skill `requires: { bins, env }` 校验（v3 再说）/ 不实现 `metadata.openclaw.install` 自动安装（用户自己 brew install）/ 不实现 LLM 驱动触发（v2 坚持 deterministic）。

---

## §11 边界约束 + END

**产出**：openclaw-skill-adapter.js (PR-26a ~150) + skill-matcher-v2.js (PR-26b ~120) + 2 test 文件 (~180)。**不动**：skill-registry.js (PR-23 `829629b`) / skill-loader.js (PR-21a `12a29ff`) / skill-watcher.js (PR-21b `b98a69f`) / context-loader.js (PR-22) / tool-catalog.js (PR-24) / tool-call-loop.js (PR-25) / PR_DESIGN_23_24_25.md (只读) / PR_DESIGN_21_SKILL_LOADER.md (只读)。**约束**：单文件 < 1000 / 单 PR < 500（PR-26a/b 各 < 200 code + < 100 tests）。**维护**：triggerType enum 4 选 1 跨 PR-21/26 共享；OpenClaw frontmatter 字段演进时 PR-26a §1.4 表增量更新；matcher-v2 性能 regression 由 PR-27 benchmark 守住 < 50ms。

> **致 Hermes PM**：PR-26 拆 2 PR（26a adapter + 26b matcher-v2），各 < 200 行 code。11 节齐全（OpenClaw 真实格式 / 字段映射 / trigger 推断 / triggerType 兑现 / API / 错误边界 / 拆分 / 测试 / 行号 / PR-27 集成 / 边界），风格对齐 `PR_DESIGN_21_SKILL_LOADER.md`。**无实现代码**，PR-21/22/23/24/25 零修改。**冲突点已自报**（§4.3）：任务原文要求"PR-23 matcher 升级"与"禁止改 skill-registry.js"互斥 —— architect 选"建新文件 + PR-27 集成时再切"，请 PM 拍板是否接受；不接受请明示允许改 skill-registry.js，architect 重新出 PR-26b 单文件设计。
