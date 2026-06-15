# ADR-009: SelfEvolution 与 LLM 决策边界（Darwin 自动 vs 老王审）

> **Status**: Proposed（待老王审）
> **Date**: 2026-06-15
> **Author**: darwin-docs (Hermes PM 派)
> **Supersedes**: -
> **Related**: [V3_ROADMAP.md §关键 ADR 雏形](../V3_ROADMAP.md) · [ADR-006](./006-human-approval-gate.md) · [ANTI_PATTERNS.md A-2/B-2](../ANTI_PATTERNS.md)

## 背景 (Context)

v1 教训：autonomous 烧光（C-2）→ Darwin 自主决策 + LLM 调用 = 算力失控 + 不可解释。v2 决策 ②"ConfigResolver 唯一入口" + 决策 ④"Tool call 协议独立"已守住"骨架 deterministic"。问题：v3+ SelfEvolution 引入 propose / diagnose 等环节，哪些走 LLM（贵 + 慢 + 不可重现）、哪些走规则推理（cheap + 快 + 可重现）？

当前 v2 状态：provider 调用 LLM（chat 路径），但 SelfEvolution 模块本身**未引 LLM**。需求：边界明确，否则 Darwin 自调用 LLM = 算力黑洞。

## 决策 (Decision)

### 模块分级（LLM 调用 vs 规则推理）

| 模块                                                                         | LLM | 决策者      | 备注                                                                       |
| ---------------------------------------------------------------------------- | --- | ----------- | -------------------------------------------------------------------------- |
| `evolution/diagnose.js`                                                      | ❌  | Darwin 自动 | 纯 introspection：文件扫描 + EventBus 历史 + memory 查询，全 deterministic |
| `evolution/propose.js`（默认）                                               | ❌  | Darwin 自动 | 纯规则推理："缺什么补什么"（读 v3+ P1 任务清单 + ADR-005 白名单），可重现  |
| `evolution/propose.js`（🔴 必审模式）                                        | ✅  | 老王审      | provider/_ 改 > 50 行 / core/_ 改 = LLM 生成 diff + 老王审                 |
| `evolution/apply.js` / `verify.js` / `rollback.js` / `audit.js` / `learn.js` | ❌  | Darwin 自动 | 机械操作（写文件/跑命令/git reset/写 JSON/写 markdown）                    |
| 边界争议（arbitration）                                                      | ✅  | 老王审      | apply 命中灰区（如白名单边缘）= 老王 LLM 仲裁                              |

### 边界规则

| 规则                              | 阈值                                                   |
| --------------------------------- | ------------------------------------------------------ |
| 单次 apply 的 LLM 调用数          | **≤ 3**（防爆）                                        |
| 单次 apply 的 LLM token 预算      | **≤ 50k input + 10k output**（cost 上限）              |
| 单 Darwin session 的 LLM 调用总数 | **≤ 20**（session 级 budget）                          |
| LLM 调用超 3 警告                 | emit `evolution:audit` 字段 `llm_budget_warning: true` |

### 应急开关

- **触发**：老王写 `~/.darwin/llm-pause` flag（任意非空内容）
- **行为**：Darwin **立即暂停所有 LLM 调用**，🔴 必审的 propose 自动转 🟡 抽样（走规则推理降级）
- **恢复**：老王删 flag → Darwin 重启后恢复 LLM 调用
- **代码标注**：每个 `evolution/*.js` 顶部必含 `const LLM_REQUIRES_APPROVAL = true|false`（与上表对齐）

## 后果 (Consequences)

### 正面

- **守住 v2 deterministic 哲学**：8 个 evolution 模块中 7 个无 LLM = 决策可重现 + 可审计
- **算力可控**：单 apply ≤ 3 次 LLM + 60k token = cost 可预算
- **应急开关**：老王 1 行 flag 文件 = 全局 kill switch，比 subagent kill 简单 100 倍

### 负面 / 风险

- **规则推理天花板**：纯规则 propose 不能"创造"新架构（如发明新的 provider 协议），只能"补缺"
- **LLM 调用突发**：🔴 必审集中在某些时段 → 单 hour 可能 10 次 LLM 调用（但单 apply 仍 ≤ 3）
- **flag 文件易误触**：`~/.darwin/llm-pause` 不小心 touch = 静默暂停（无通知）

### 中和 (Mitigations)

| 风险           | 缓解                                                                |
| -------------- | ------------------------------------------------------------------- |
| 规则推理天花板 | P1 阶段允许 Darwin 在 🟢 自动档引入"小 LLM 调用"（如补 skill 描述） |
| LLM 调用突发   | session 级 budget（≤ 20）+ cron 监控，超限告警                      |
| flag 误触      | flag 写入时 emit `lifecycle:bootstrap` warning log + 老王 a2a 通知  |

## 备选方案 (Alternatives Considered)

- **方案 A：所有 decision 走 LLM** → 拒绝：v1 烧光教训 + cost 不可控 + 决策不可重现
- **方案 B：所有 decision 走规则（无 LLM）** → 拒绝：🔴 必审的复杂 propose（code gen）规则推理写不出来
- **方案 C：LLM 调用无 budget 限制** → 拒绝：cost 黑洞 + 触发老王 emergency shutdown

## 实施细节

- **文件路径**：
  - `evolution/diagnose.js` / `evolution/propose.js` / ...（每个模块顶部必含 `LLM_REQUIRES_APPROVAL` 常量）
  - `evolution/llm-monitor.js`（LLM 调用计数 + budget 警告）
  - `~/.darwin/llm-pause`（应急 flag 文件，runtime 检测）
- **事件流**：每次 LLM 调用 → emit `provider:call:before`+`:after`（v2 已有，SelfEvolution 复用）；超 3 次 → `evolution:audit` 字段 `llm_budget_warning: true`；session 超 20 → 老王 a2a 通知（不 abort，只告警）
- **配置**（`config/evolution-llm-budget.json`）：`per_apply: {max_calls:3, max_input_tokens:50000, max_output_tokens:10000}` / `per_session: {max_calls:20}`
- **flag 检测**：`lifecycle:bootstrap:start` 时检查 `~/.darwin/llm-pause`，若存在 → emit warning + 写入 runtime ctx
