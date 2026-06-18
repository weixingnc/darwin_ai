# ADR-005: SelfEvolution 边界（Darwin 能改什么 / 不能改什么）

> **Status**: Accepted (2026-06-18) — v3 P0/P1/P2 cycle all pass, see cycle SHAs in body
> **Date**: 2026-06-15
> **Author**: darwin-docs (Hermes PM 派)
> **Supersedes**: -
> **Related**: [V3_ROADMAP.md §关键 ADR 雏形](../V3_ROADMAP.md) · [ANTI_PATTERNS.md A-2/B-2](../ANTI_PATTERNS.md)

## 背景 (Context)

v1 教训：DarwinCore.js 2621 行单文件 + 跨模块直接 import 业务函数（ANTI_PATTERNS A-1/A-2）→ 改一处崩三处。v2 通过"骨架 only" + EventBus 单向通信 + ConfigResolver 唯一入口守住了边界（A-4）。v3+ Darwin 用 SelfEvolution 自己长肉（P0），若不划清"能改 / 不能改"，Darwin 会重蹈"改坏 core 而无回滚"的覆辙（F-8）。

当前 v2 状态：8 PR 全过（PR-27 340/340 tests），5 硬标准守住。问题：Darwin 获得 evolution:apply 后，**第一次自主长肉**会不会伤到 v2 守住的契约（核心 + 反模式 + 依赖锁）？

## 决策 (Decision)

### ✅ Darwin 能改（白名单）

| 范围                            | 例子                           | 改的理由                                |
| ------------------------------- | ------------------------------ | --------------------------------------- |
| `provider/*.js`                 | `provider/anthropic.js`        | 扩展新 LLM 协议（deepseek / qwen 原生） |
| `tool/builtins/*`               | `tool/builtins/glob.js`        | 新增内置工具                            |
| `skill/examples/*`              | `skill/examples/summarizer.js` | 新增 demo skill                         |
| `memory/backends/*`             | `memory/backends/vector.js`    | 新增 vector 后端（v3+ P1）              |
| `docs/*.md`（除 ANTI_PATTERNS） | `docs/USAGE.md`                | 文档同步扩展                            |
| `tests/**`                      | `tests/tool-glob.test.js`      | 单测随代码                              |

### ❌ Darwin 不能改（黑名单——硬拦截）

| 范围                                                                                                               | 不能改的理由                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `core/event-bus.js` / `core/config-resolver.js` / `core/events.js` / `core/container.js` / `core/error-handler.js` | A-2/A-4 教训：核心契约稳定 = PR-23 字节级 byte-equal 硬约束    |
| `docs/ANTI_PATTERNS.md`                                                                                            | 监督机制（PM 周复盘 + reviewer reject），改 = 自己改自己的红线 |
| `package.json` / `.commitlintrc.json` / `.eslintrc.json`                                                           | 依赖锁 + 编码规则 CI 化（v2 决策 ⑤）                           |
| `lifecycle/*.js`                                                                                                   | bootstrap/shutdown = 系统生命周期，碰错 = 启不来               |
| `core/self-evolution.js`（自身）                                                                                   | SelfEvolution 不能改自己 = 防止递归改坏                        |

### 决策矩阵

| 文件范围                                  | apply 行为                                  |
| ----------------------------------------- | ------------------------------------------- |
| 白名单                                    | ✅ 允许 + 按 ADR-006 走审批门               |
| 黑名单（5 个核心 + ANTI_PATTERNS + 配置） | 🚫 apply 前 abort + emit `evolution:reject` |
| 不在白/黑名单（如新文件）                 | ⚠️ 默认走 🔴 必审（ADR-006 红档）           |

## 后果 (Consequences)

### 正面

- **守住 v2 byte-equal**：核心 + 配置 + ANTI_PATTERNS 三层契约 = Darwin 不能动 → PR-23/27 的硬约束延续
- **可审计**：每次 apply 的 files_changed 必含路径 + 黑白分类，audit 一目了然
- **扩展边界清晰**：Darwin 知道"能加什么" = 5 类白名单（provider/tool/skill/memory/docs/tests）

### 负面 / 风险

- **白名单过宽**：Darwin 改坏 `provider/*.js` 不会触发任何硬拦截（需 ADR-006 审批门 + ADR-009 LLM 边界救场）
- **新文件分类**：未在白/黑名单的新文件 = 默认走必审 → 可能审批噪音
- **黑名单漏列**：若 v3+ 新增 `core/*` 文件（如 `core/memory-registry.js`），黑名单需同步更新

### 中和 (Mitigations)

| 风险           | 缓解                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| 白名单过宽     | ADR-006 审批门（provider/\* 改 > 50 行必审）+ ADR-009 LLM 边界                                                        |
| 新文件分类噪音 | apply 前 emit `evolution:propose:after` 含默认档位，老王可改档                                                        |
| 黑名单漏列     | CI 校验：`evolution/apply.js` 启动时拉 `config/evolution-whitelist.json` + `evolution-blacklist.json`，两表 PR 时同步 |

## 备选方案 (Alternatives Considered)

- **方案 A：完全自由（无黑白名单）** → 拒绝：v1 教训 A-1 重蹈（DarwinCore 2621 行就是无边界堆出来的）
- **方案 B：白名单 only（无黑名单）** → 拒绝：核心 + 配置 + ANTI_PATTERNS 必须硬拦截，否则改坏没救
- **方案 C：黑名单 only（无白名单）** → 拒绝：黑名单列不完新文件，白名单给出"达尔文能加什么"的正向引导

## 实施细节

- **文件路径**：
  - `config/evolution-whitelist.json`（白名单 glob pattern）
  - `config/evolution-blacklist.json`（黑名单 glob pattern，硬拦截）
  - `evolution/apply.js`（apply 前必查两表）
- **事件流**：
  - `evolution:apply:before` 携带 `files_changed[]` → apply 校验
  - 命中黑名单 → emit `evolution:reject` + abort + 不写文件
- **配置示例**（`evolution-blacklist.json`）：
  ```json
  {
    "patterns": [
      "core/event-bus.js",
      "core/config-resolver.js",
      "core/events.js",
      "core/container.js",
      "core/error-handler.js",
      "core/self-evolution.js",
      "lifecycle/*.js",
      "docs/ANTI_PATTERNS.md",
      "package.json",
      ".commitlintrc.json",
      ".eslintrc.json",
      ".prettierrc"
    ]
  }
  ```
- **CI 校验**：PR 改 `core/*` 或 `package.json` 时，`evolution-blacklist.json` 必含此路径（防漏列）

## Acceptance Note (2026-06-18)

Promoted from Proposed to Accepted after v3+ P0/P1/P2 cycles all passed
the 4-step verification gate (test + lint + size-check + diagnose).
The boundary has held across 38+ cycles without violation.

Cycle SHAs that exercised this boundary:

- P2a (`a9fd668`) — plugin add CLI bug fix (boundary: plugin/\* only)
- P2d (`f6f3e6d`) — manifest security (boundary: plugin/\* only)
- P2e (`52a645b`) — runtime sandbox monkey-patch (boundary: provider/\*)
- P2f (`55d90a5`) — self-evolve orchestrator (boundary: evolution/\*)
- P3a (`8071460`) — self-evolve CLI entry (boundary: bin/\*)
- W4-2 (`459c12d`) — Darwin self-grows rate-limiter (full boundary in action)

The blacklist in `evolution/evolution-blacklist.json` is the runtime
enforcement of this ADR. CI verification ensures new files in blacklisted
paths trigger a PR-block.
