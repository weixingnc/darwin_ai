# ADR-008: 审计与学习（audit log + memory schema + learn 闭环）

> **Status**: Accepted (2026-06-18) — v3 P0/P1/P2 cycle all pass, see cycle SHAs in body
> **Date**: 2026-06-15
> **Author**: darwin-docs (Hermes PM 派)
> **Supersedes**: -
> **Related**: [V3_ROADMAP.md §关键 ADR 雏形](../V3_ROADMAP.md) · [ADR-007](./007-rollback-strategy.md) · [ANTI_PATTERNS.md B-2/E-2](../ANTI_PATTERNS.md)

## 背景 (Context)

v1 教训：黑盒改（A-2 延伸）→ 改了不记 = 半年后 debug 不知为何。v2 已落"340/340 tests + 5 硬标准"但无 apply 审计。问题：v3+ SelfEvolution apply 后 = 改了 v2 守住的契约 → 必须留痕 + learn，否则下次 propose 重犯同错。

当前 v2 状态：commit 历史完整（8 PR + commitlint），但 apply 无 schema 化审计 → 老王周复盘靠 git log（散点）。

## 决策 (Decision)

- **路径**：`memory/audit/YYYY-MM-DD-<proposal_id>.json` · **写入**：`evolution:apply:after` 触发（success / rollback 都必写）· **归档**：7 天后 → `memory/audit/.archive/YYYY-MM/`

### audit log schema（JSON）

```json
{
  "proposal_id": "uuid-v4",
  "action": "apply",
  "files_changed": [
    { "path": "provider/anthropic.js", "diff_type": "+", "lines": 42 },
    { "path": "tests/provider-anthropic.test.js", "diff_type": "+", "lines": 18 }
  ],
  "diff_stat": { "+": 60, "-": 3 },
  "verify_result": { "test": true, "lint": true, "size_check": true },
  "duration_ms": 12453,
  "outcome": "success",
  "apply_author": "darwin",
  "session_key": "agent:darwin-coder:task-xyz",
  "tag_sha": "abc1234"
}
```

| 字段组                                                                                                                                                                                                    | 必带       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 必带：`proposal_id` / `action` / `files_changed[].{path,diff_type,lines}` / `diff_stat.{+,-}` / `verify_result.{test,lint,size}` / `duration_ms` / `outcome` / `apply_author` / `session_key` / `tag_sha` | ✅         |
| 条件字段：`approver`（🔴 必审时）· `rollback_reason`（rollback 时）                                                                                                                                       | 触发时必带 |

> enum 约定：`action`=`apply`/`rollback`，`outcome`=`success`/`rollback`，`apply_author`=`darwin`/`laowang`，`diff_type`=`+`/`-`/`~`。

### learn 闭环

- **路径**：`memory/learnings/evolution-rules.md` · **写入者**：Darwin 自追加（每次 rollback 必写 1 条）· **格式**：人类可读 markdown，老王可改可删 · **读取**：`evolution/propose.js` 必读此文件 → 影响下次 propose 规则推理
- **示例**（markdown 而非 JSON）：

```markdown
### 2026-06-15-001

- 场景: provider/anthropic.js streaming chunk 改错
- 错误: verify 失败（lint: unused var）
- 规则: 下次改 streaming 类 provider 先 lint 本地
```

### 边界

- 每次 apply（success/rollback）→ audit log 必留 · 每次 rollback → learn 必写 1 条
- 7 天后 audit log → 自动归档 `memory/audit/.archive/YYYY-MM/`
- audit log 写失败 → 🛑 apply abort（无审计 = 无 learn）

## 后果 (Consequences)

### 正面

- **v1 黑盒改 = 死**：每次 apply 结构化审计 → 老王周复盘有数据（E-2 教训延伸）
- **learn 闭环**：rollback → learn → 下次 propose 读到 = 不重犯
- **人类可读**：`evolution-rules.md` = markdown，老王可 review/改/删

### 负面 / 风险 + 中和

| 风险                      | 缓解                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| 磁盘增长（100 文件/天）   | cron 日清理 + 月归档，archive 自动 gzip                                 |
| learn 规则噪声            | `evolution-rules.md` 单文件 ≤ 500 行（超 = 老王周末 review 折叠老规则） |
| schema 演进（v4+ 加字段） | JSON 含 `schema_version` 字段，读取时向下兼容                           |

## 备选方案 (Alternatives Considered)

- **方案 A：仅 audit log（无 learn）** → 拒绝：B-2 教训"散点活不分类"延伸，audit 是数据不 = 学习
- **方案 B：仅 learn（无 audit log）** → 拒绝：缺数据 = learn 凭感觉，不可复现
- **方案 C：审计写入远端 DB** → 拒绝：v3+ 启动期不引外部依赖（违反骨架 only 哲学）

## 实施细节

- **文件路径**：`evolution/audit.js`（写 audit log）· `evolution/learn.js`（写 rules）· `memory/audit/`（含 `.archive/`，`.gitignore` 必加）· `memory/learnings/evolution-rules.md`（不进 git = 老王 review 后手动 commit）
- **事件流**（`core/events.js` 已定义：`EVOLUTION_AUDIT='evolution:audit'` / `EVOLUTION_LEARN='evolution:learn'`）：`apply:after` → `verify` → `audit` → `learn`（rollback 也走同链）
- **schema 验证**：`evolution/audit.js` 启动加载 `evolution/audit-schema.json`（含 `schema_version` 字段，向下兼容）

## Acceptance Note (2026-06-18)

Promoted from Proposed to Accepted after v3+ P0/P1/P2 cycles all passed.
The audit plugin (P2c-2 / P2j) has captured every Darwin evolution event
in JSONL at `~/.darwin/audit.jsonl`. Memory schema v2 has been stable
across all cycles.

Cycle SHAs that exercised audit:

- P2c-2 (`71e0ffb`) — first audit plugin, v0.1.0 (in-memory)
- P2j (`1d4275e`) — audit v0.2.0, on-disk JSONL persistence
- W4-1 (`cc1931e`) — metrics plugin (sister observability tool)

The audit schema is documented in `docs/AUDIT_SCHEMA.md` (when shipped).
For now, the schema is implicit in `plugin/audit.js` + `evolution/audit.js`.
