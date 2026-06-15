# ADR-007: 回滚策略（git tag + OpenClaw session backup）

> **Status**: Proposed（待老王审）
> **Date**: 2026-06-15
> **Author**: darwin-docs (Hermes PM 派)
> **Supersedes**: -
> **Related**: [V3_ROADMAP.md §关键 ADR 雏形](../V3_ROADMAP.md) · [ANTI_PATTERNS.md F-5/F-6/F-8](../ANTI_PATTERNS.md)

## 背景 (Context)

v1 教训：改坏无回滚（A-1 延伸）→ DarwinCore.js 改错 = 整个 Darwin 挂。v2 派活 SOP 已拍"git tag + reset"模式（F-5 cherry-pick 拆 commit 教训 + F-6 PM 操作 git 4 步自查），但**Darwin 自己**（非 PM/subagent）的自主 apply 没回滚通道。问题：v3+ `evolution:apply` 失败 = `verify` 不通过 → 必须自动回滚，否则 Darwin 改坏自己卡死。

当前 v2 状态：`git tag` 实践已落地（F-8 PM 接管 SOP），但缺"apply 前的自动 tag + 失败自动 reset"。

## 决策 (Decision)

### 三层回滚机制

| 层                              | 时机        | 动作                                                     |
| ------------------------------- | ----------- | -------------------------------------------------------- |
| **L1: git tag**                 | apply 前    | `git tag evolution-pre-<proposal_id>-<unix_ts>` 永久保留 |
| **L2: OpenClaw session backup** | apply 前    | proposal_id 绑定 session key + session jsonl 备份 7 天   |
| **L3: verify 失败自动回滚**     | verify 失败 | `git reset --hard <tag>` + 重跑 verify（必须再过）       |

### Tag 命名规则

```bash
# apply 前
TAG="evolution-pre-${PROPOSAL_ID}-$(date +%s)"
git tag "$TAG"
git rev-parse "$TAG"  # → audit log 必含 SHA

# verify 失败
git reset --hard "$TAG"

# 重跑 verify
npm test && npm run lint && npm run size-check  # 必须全过
```

### OpenClaw session backup

- **路径**：`~/.openclaw/agents/darwin-coder/sessions/.backup/` · **保留期**：7 天（cron 自动清理）· **绑定**：`proposal_id` ↔ `session_key`（双向索引落 `memory/audit/session-index.json`）· **恢复**：人工 `sessions_history(session_key)` 拉历史 → 改 proposal

### 边界条件

| 条件                                      | 行为                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| 单次 verify 失败                          | L3 自动回滚 + audit + learn                                         |
| 连续 3 次回滚（同 Darwin session）        | 🛑 **触发人工 learn 模式**：Darwin 暂停自主 apply **24h**，老王介入 |
| tag 失败（git 异常）/ session backup 失败 | 🛑 apply abort + `evolution:reject`（不写文件 = 永远可恢复）        |

## 后果 (Consequences)

### 正面

- **守住 v1 教训**：改坏永远能回滚（tag + session 双备份）
- **verify 失败 = 自动救场**：无需老王手动 reset，Darwin 自救
- **连续 3 次 = 强制 learn**：防止 Darwin 反复撞同一坑（F-6 反射延伸）

### 负面 / 风险

- **tag 堆积**：每次 apply 一个 tag → 100 次 apply = 100 个 tag → 需定期清理（已超过 7 天的）
- **reset --hard 高危**：F-5 教训"git reset 高危手工操作" → 自动 reset 需 F-6 自查清单
- **session backup 7 天不够**：长周期 debug 可能需 30 天历史 → 边界需明确

### 中和 (Mitigations)

| 风险            | 缓解                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| tag 堆积        | 每月 cron 清理 `evolution-pre-*` tag 中 > 30 天 + audit 已归档的                              |
| reset 高危      | `evolution/rollback.js` 必走 F-6 自查：当前分支 / working tree / npm test baseline / 期望 SHA |
| backup 7 天不够 | 关键 apply（🔴 必审）备份延至 30 天，🟢🟡 7 天                                                |

## 备选方案 (Alternatives Considered)

- **方案 A：仅 git tag（无 session backup）** → 拒绝：apply 上下文（事件流 + LLM 调用历史）丢 = learn 闭环缺料
- **方案 B：仅 session backup（无 git tag）** → 拒绝：session 是 jsonl 不含文件 diff，无法 reset 文件
- **方案 C：双备份 + 无限期保留** → 拒绝：磁盘爆 + 隐私风险（session 可能含 LLM 真值）

## 实施细节

- **文件路径**：
  - `evolution/rollback.js`（verify 失败自动 reset）
  - `scripts/evolution-tag-cleanup.sh`（cron 月清理）
  - `~/.openclaw/agents/darwin-coder/sessions/.backup/`（session 备份目录）
- **事件流**（用 `core/events.js` 已定义的常量名）：
  - `EVOLUTION_VERIFY` = `'evolution:verify'`（verify 阶段 emit，含 pass/fail）
  - `EVOLUTION_ROLLBACK` = `'evolution:rollback'`（回滚时 emit，含 from/to SHA）
- **F-6 自查清单**（`evolution/rollback.js` 内嵌）：
  ```
  操作类型:     git reset --hard
  target branch: main
  当前分支:     $(git branch --show-current)  ← 必须 == main
  working tree: $(git status --short | wc -l) 行
  期望 SHA:    <tag SHA>
  ```
- **连续 3 次回滚检测**：维护 `memory/audit/rollback-counter.json`，每 Darwin session 重启清零
