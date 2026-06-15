# ADR-006: 人工审批门（哪些 apply 需老王审）

> **Status**: Proposed（待老王审）
> **Date**: 2026-06-15
> **Author**: darwin-docs (Hermes PM 派)
> **Supersedes**: -
> **Related**: [V3_ROADMAP.md §关键 ADR 雏形](../V3_ROADMAP.md) · [ADR-005](./005-self-evolution-boundary.md) · [ANTI_PATTERNS.md C-1/C-2](../ANTI_PATTERNS.md)

## 背景 (Context)

v1 教训：autonomous 烧光（C-2 信 subagent 自报）→ 4 次 OpenClaw timeout 通知实际都成功。v2 派活 SOP 拍板"4 件套 prompt + 4 步硬验"（C-1/C-2），但**Darwin 自己**（非 subagent）的自主 apply 没有审批门。问题：v3+ SelfEvolution 触发 `evolution:apply` 时，哪些"老王必看"、哪些"Darwin 自主"？

当前 v2 状态：8 PR 全过，无 Darwin 自主 apply 通道。需求：SelfEvolution 必须有"审批门"，否则 Darwin 改坏 `provider/*.js` 无救。

## 决策 (Decision)

### 三档审批矩阵

| 档位                 | 触发条件                                                                                                                       | 行为                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 🔴 **必审**          | `provider/*.js` 改动 > 50 行 / 任何 `core/*` 改动（黑名单兜底）/ `package.json` 改动 / `lifecycle/*` 改动 / 不在白名单的新文件 | 老王审 → `evolution:approve` 或 `evolution:reject` |
| 🟡 **抽样审（10%）** | `tool/builtins/*` 新增文件                                                                                                     | 10% 抽样 = 老王审，其余走自动                      |
| 🟢 **自动通过**      | `skill/examples/*` 新增 / `memory/backends/*` 新增 / `docs/*.md` 改（除 ANTI_PATTERNS）/ `tests/**` 改                         | emit `evolution:approve` 走 apply                  |

### 决策时间窗口

| 阶段          | 超时行为                                                           |
| ------------- | ------------------------------------------------------------------ |
| 🔴 必审 apply | 24h 内未批 = **自动 `evolution:reject`**（防 Darwin 卡审批长等）   |
| 🟡 抽样审     | 1h 内未批 = 默认 `evolution:approve`（10% 抽中的老王未看视作放过） |
| 🟢 自动通过   | 无审批，audit 留痕即可                                             |

### 审批流（a2a 协议）

```text
evolution:propose:after → [apply 分类]
  ├─ 🟢 自动 → evolution:approve (SelfEvolution 自 emit) → evolution:apply:before
  ├─ 🟡 抽样 → 掷骰子 (10%) → 若中 → 等老王 / 否则 → evolution:approve
  └─ 🔴 必审 → 老王 a2a 通道 → evolution:approve | evolution:reject
      ├─ approve → evolution:apply:before
      └─ reject → audit 留痕 + evolution:reject → learn 闭环
```

## 后果 (Consequences)

### 正面

- **守住 v2 C-2 教训**：信审批不信 Darwin 自报告，所有 🔴 走老王 a2a 协议
- **流量分级**：🟢 自动（多数）+ 🟡 抽样（少数）+ 🔴 必审（极少）= 老王负担可控
- **24h 超时防卡**：Darwin 不会被单条 apply 阻塞一整天

### 负面 / 风险

- **10% 抽样不均**：纯随机可能某类 builtin 全抽中或全不中 → 需按文件 hash 取模稳态
- **24h 超时可能误伤**：老王周末休息时 🔴 apply 自动 reject → 真紧急的也跑不了
- **🟢 自动过宽**：skill/memory 新增走自动，Darwin 可能加坏 skill 不被发现

### 中和 (Mitigations)

| 风险        | 缓解                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| 抽样不均    | 抽样函数按 `proposal_id` hash 模 100，确保同类 apply 长期均分           |
| 24h 误伤    | 老王可设 `~/.darwin/approval-vacation` flag → 🔴 转 🟡（周末降档）      |
| 🟢 自动过宽 | audit log 必留痕 + learn 闭环（ADR-008）→ 坏 skill 触发 rollback 写规则 |

## 备选方案 (Alternatives Considered)

- **方案 A：全部必审** → 拒绝：老王负担过重，违反 v3+ "Darwin 自主长肉"哲学
- **方案 B：全部自动（无人审）** → 拒绝：C-2 教训 autonomous 烧光，apply 改坏无救
- **方案 C：按"风险评分"动态审** → 拒绝：评分规则难定义 + PM 维护负担，三档静态已够

## 实施细节

- **文件路径**：
  - `evolution/apply.js`（apply 分类 = 三档判定）
  - `evolution/approval.js`（a2a 协议层，老王 emit approve/reject）
  - `config/evolution-gates.json`（三档阈值配置：50 行 / 10% / 24h）
- **事件流**（用 `core/events.js` 已定义的常量名）：
  - `EVOLUTION_APPROVE` = `'evolution:approve'`（老王或 SelfEvolution 自 emit）
  - `EVOLUTION_REJECT` = `'evolution:apply'`（老王 emit 或 24h 超时自 emit）
  - 走 a2a 协议 = OpenClaw session 间 `sessions_send(sessionKey=laowang, ...)`
- **配置示例**（`evolution-gates.json`）：
  ```json
  {
    "must_approve": { "provider_lines": 50, "approval_timeout_h": 24 },
    "sample_approve": { "rate": 0.1, "default_timeout_h": 1 },
    "auto_approve": ["skill/examples/*", "memory/backends/*", "docs/*", "tests/**"]
  }
  ```
- **老王 a2a 协议命令**：`evolution:approve <proposal_id>` / `evolution:reject <proposal_id> <reason>`
