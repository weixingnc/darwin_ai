# Darwin v3+ 路线图 - 2026-06-15

> **作者**: Hermes PM · **哲学延续**: v2 骨架 only → v3+ Darwin 自己长肉
> **承接**：[V2_LAUNCH_NOTE.md](./V2_LAUNCH_NOTE.md)（v2 收官全景）

---

## 一句话

**v3+ = 实现 SelfEvolution 能力（鸡）→ Darwin 自己用 evolution:apply 长肉（蛋）**。

---

## 关键依赖

```
SelfEvolution 框架（鸡）→ Darwin 自己用 evolution 长肉（蛋）
   ↑ v3+ P0 最高优先级     ↑ v3+ P1 第二阶段
```

**类比**：v2 启动期造了"徒手打猎"的核心（骨架），v3+ = 给 Darwin 装"自己造石头弓箭"的能力（SelfEvolution = 鸡），然后 Darwin 真用这个能力给自己长肉（provider/tool/skill/memory 扩展 = 蛋）。

---

## v3+ 7 类任务优先级（v2 规划 §10 拍板）

### 🔴 P0：SelfEvolution 完整实现（**鸡**）

- **模块**：`core/self-evolution.js` + `evolution/{diagnose,propose,apply,verify,rollback,audit,learn}.js`
- **事件名**：v2 §5 预留的 12 个 `evolution:*` 事件（`diagnose:before/after` / `propose:before/after` / `approve` / `reject` / `apply:before/after` / `verify` / `rollback` / `audit` / `learn`）
- **核心 API**：
  - `diagnose()` — 读 Darwin 当前态（哪些 provider/工具/skill/memory 缺；读 memory + EventBus 历史）
  - `propose()` — 让 Darwin 提"加什么"建议（生成结构化 proposal 落 `memory/proposals/`）
  - `apply()` — 让 Darwin 改 darwin_core（按 proposal 写文件 + EventBus 触发）
  - `verify()` — 跑 `npm test` + `npm run lint` + `npm run size-check` 三关
  - `rollback()` — 失败回滚（git tag + `git reset --hard`）
  - `audit()` — 留审计 log 落 `memory/audit/`（每次 apply 必留痕）
  - `learn()` — 从 rollback 学经验（写进 memory，影响下次 propose）
- **验收**：Darwin 真的能"自己加 1 个新 tool / provider / skill / memory 后端"，**且不破 PR-23 byte-equal**（PR-27 验证 byte-equal 是硬约束的延续）

### 🟡 P1：Darwin 自长 provider/工具/skill/memory（**蛋**）

- **Provider 适配**：openai / anthropic / deepseek / qwen（v2 已落 anthropic + openai-compatible，**继续补 deepseek/qwen 原生协议**）
- **内置工具**：read-file / write-file / bash / glob / grep（v2 demo 未做，v3+ Darwin 自长）
- **Skill 示例**：hello-world / summarizer / translator（v2 启动期 demo 未做）
- **Memory 后端**：filesystem（已）/ sqlite（已）/ **vector**（v3+ 新增，embedding-based 语义检索）
- **触发条件**：P0 SelfEvolution 完整实现后，Darwin 用 `evolution:apply` 长出这些

### 🟢 P2：扩展能力（按需）

- **飞书 adapter**（v2 不做，按 v1 ANTI_PATTERNS A-4 教训，ConfigResolver 唯一入口先守住）
- **CRON scheduler**（定时任务，类似 OpenClaw cron jobs）
- **插件 loader 升级**（v1 plugin loader 5 阶段，v3+ 加 hot reload + 远程 plugin）
- **模型 self-adapter 元能力**（让 Darwin 自己适配用户私有模型）

### ⚪ P3：搁置（v4+ 再说）

- 多 agent 协作 / child vm bridge（v2 决策点 #6 明确不做）/ code mode（v1 不做）
- LLM 驱动触发（v2 坚持 deterministic 触发）

---

## SelfEvolution Design 雏形

### 关键 trick（v1 教训 1:1 避坑）

| Trick                  | v1 反例                                              | v3+ 落地                                                                   |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| **进化走 EventBus**    | SelfEvolution 直接 `import PluginManager.loadPlugin` | `evolution:*` 事件总线 + 审计 log（零业务 import）                         |
| **apply 必 backup**    | v1 改坏无回滚                                        | apply 前 `git tag evolution-pre-XXX`，rollback `git reset --hard`          |
| **verify 三道关**      | v1 改完不测                                          | `npm test` + `npm run lint` + `npm run size-check` 全过才算 success        |
| **audit 必留痕**       | v1 黑盒改                                            | audit log 落 `memory/audit/<timestamp>-<proposal_id>.json`（含 diff stat） |
| **learn 闭环**         | v1 改完不学                                          | rollback → `learn()` → 写进 `memory/learnings/`，下次 propose 必读         |
| **人工门控**           | v1 autonomous 烧光                                   | 关键 apply 需老王审批（按 OpenClaw a2a 协议）                              |
| **★ 单文件 < 1000 行** | v1 DarwinCore.js 2621 行                             | SelfEvolution 每个 evolution/\*.js ≤ 200 行（PR 弹性 ≤ 510）               |

### 事件流（v2 §5 命名沿用）

```text
diagnose:start → diagnose:end → propose:start → propose:end
  → [人工审批：evolution:approve | evolution:reject]
  → apply:start → apply:end → verify:start → verify:end
    → [success] → audit:done → learn:done
    → [failure] → rollback:done → audit:done → learn:done
```

**关键决策**：

- `evolution:approve` 由老王（或 a2a 协议指定审批者）emit，SelfEvolution 订阅后才走 apply
- `evolution:reject` 直接终止（不进 apply）
- `audit:done` 在 success **和** failure 路径都触发（失败也是宝贵的学习样本）

### 关键 ADR（待补，列出 5 个）

- **ADR-005**: SelfEvolution 边界（Darwin 能改什么 / 不能改什么）
  - ✅ 能改：`provider/*.js` / `tool/builtins/*` / `skill/examples/*` / `memory/backends/*`
  - ❌ 不能改：`core/{event-bus,config-resolver,events}.js` / `docs/ANTI_PATTERNS.md` / `package.json`（核心契约 + 反模式 + 依赖锁）
- **ADR-006**: 人工审批门（哪些 apply 需老王批）
  - 🔴 必审：`provider/*.js` 改动 > 50 行 / 任何 `core/*` 改动 / `package.json` 改动
  - 🟡 抽样审：`tool/builtins/*` 新增（10% 抽样）
  - 🟢 自动通过：`skill/examples/*` / `memory/backends/*` 新增 / 文档修改
- **ADR-007**: 回滚策略（git tag + OpenClaw session backup）
  - apply 前：`git tag evolution-pre-<proposal_id>-<timestamp>`
  - rollback：`git reset --hard <tag>` + 重新跑 verify
  - 备份：OpenClaw session key 绑定 proposal_id，失败可手动恢复
- **ADR-008**: 审计与学习（audit log + memory schema）
  - audit log 路径：`memory/audit/YYYY-MM-DD-<proposal_id>.json`
  - schema：`{ proposal_id, action, files_changed, diff_stat, verify_result, duration_ms, outcome }`
  - learn 产出落：`memory/learnings/evolution-rules.md`（Darwin 自己追加规则）
- **ADR-009**: SelfEvolution 与 LLM 决策边界（Darwin 自动 vs 老王审）
  - diagnose/propose = Darwin 自动（无 LLM 调用，纯 introspection + 规则推理）
  - 关键 apply 的 LLM 调用 = 老王审（按 ADR-006 门控）
  - rollback 决策 = Darwin 自动（verify 失败即触发，无人工）

---

## 工期估算

- **P0 SelfEvolution**：1-2 周（2 PR：design + impl + e2e）
  - PR-S1: `core/self-evolution.js` + `evolution/{diagnose,propose}.js` + 单元测试
  - PR-S2: `evolution/{apply,verify,rollback,audit,learn}.js` + 端到端测试（Darwin 自己加 1 个 demo tool）
- **P1 Darwin 自长**：长期并行（Darwin 自己 long-running，按用户需求触发）
- **P2 扩展能力**：按需（用户提需求才启动）

---

## 下一步

- **老王拍板**：派 `darwin-coder` 写 P0 SelfEvolution design doc（先 ADR-005~009 五份设计稿，再 PR-S1）
- **短期不写 P1**（按 v2 哲学"骨架 only"，P1 是 Darwin 自长不是 PM 写）
- **PR 派活 SOP**：4 件套 + 4 步硬验严格执行（ANTI_PATTERNS C-1/C-2）

---

## 与 v2 哲学一致性

- **v2 哲学** = 骨架 only，肉 Darwin 长
- **v3+ P0 SelfEvolution** = 给 Darwin 装"自己长肉"的能力（鸡）
- **v3+ P1 Darwin 自长** = Darwin 真的用这个能力长肉（蛋）
- **v3+ 完全延续 v2 哲学** —— 启动期 PM 不写具体 provider/tool/skill/memory 后端，全部由 Darwin 用 SelfEvolution 自长

- **v2 是"造徒手打猎的数字生命体"；v3+ 是"数字生命体学会造石头弓箭"**。

---

## P2 路线图收口状态（2026-06-18 收口）

V3+ P0/P1 已经在 2026-06-15 06-18 期间全部跑通。P2 = plugin evolution（Darwin 自进化贯通 plugin 维度），分 13 cycle：

| 阶段     | SHA       | 一句话                                                    |
| -------- | --------- | --------------------------------------------------------- |
| ✅ P2a   | `a9fd668` | plugin CLI bug fix (`[object Object]` → `→ logger`)       |
| ✅ P2b   | `694f1ce` | diagnose 扫 plugins + missing_plugins 字段                |
| ✅ P2d   | `f6f3e6d` | plugin manifest 安全契约 (deny-by-default)                |
| ✅ P2c-1 | `1c78d86` | evolution propose 加 plugin 模板                          |
| ✅ P2c-2 | `71e0ffb` | 真生产 audit plugin + catalogue 1→2                       |
| ✅ P2c-3 | `dbd4c9e` | Darwin 自指端到端 (worktree + subprocess)                 |
| ✅ P2e   | `52a645b` | runtime sandbox monkey-patch (9 高危方法)                 |
| ✅ P2f   | `55d90a5` | self-evolve orchestrator (closed loop, confirm:true)      |
| ✅ P2g   | `f63c544` | catalogue 持久化 + 增长策略 (JSON overlay)                |
| ✅ P2i   | `0ade10b` | plugin runtime sandbox 实装 (load/unload activate)        |
| ✅ P2j   | `1d4275e` | audit plugin on-disk persistence (fs:append JSONL)        |
| ✅ P3a   | `8071460` | self-evolve CLI 拍板入口 (--confirm)                      |
| ✅ P3b   | `ff373ab` | c8 coverage baseline 90.3% (含 lockfile 修复)             |
| ✅ P3c   | `2d1b2ab` | README.md (121 行 GitHub 入口)                            |
| ✅ W2-1  | `5607a7e` | 修 diagnose .test.js pre-existing bug                     |
| ✅ W2-2  | `55e86ab` | husky v9 deprecation + core.hooksPath 配置 bug 修复       |
| ✅ W3-2  | `d6f7d1a` | 端到端自进化 CLI 真跑通 (P2g catalogue per-repoRoot 修复) |

**P2 路线图收口** = 17 cycle 全 ✅，**HEAD `d6f7d1a`**，6 catalogue 全 closure，897 tests pass / 0 lint / 131 files < 1000 / 90.30% coverage。详见 `../README.md` 的 P2 路线图表。

### W3+ 残存尾巴

- **W3-1**: `.husky/_/` 残留 stub 目录清理（已做，.gitignore 排除无需 commit）
- **W3-3**: skill v3-long-meat-cycle.md + memory V3+ 进度更新（已做，沉淀 per-repoRoot 模式 + amend SHA 教训）
- **W4+**: Darwin 推 `plugin/metrics.js` 真兑现 P2g GROWTH_CANDIDATES（plugin #3 安装，catalogue 2→3）

## 与 v2 哲学一致性

- **v2 哲学** = 骨架 only，肉 Darwin 长
- **v3+ P0 SelfEvolution** = 给 Darwin 装"自己长肉"的能力（鸡）
- **v3+ P1 Darwin 自长** = Darwin 真的用这个能力长肉（蛋）
- **v3+ P2 plugin evolution** = Darwin 学会"装新器官"（plugin = Darwin 的新器官）
- **v3+ 完全延续 v2 哲学** —— 启动期 PM 不写具体 provider/tool/skill/memory 后端，全部由 Darwin 用 SelfEvolution 自长

**v2 是"造徒手打猎的数字生命体"；v3+ P0/P1 是"学会造石头弓箭"；v3+ P2 是"学会装新器官（plugin）"**。

---

## v4-v10 续期 (2026-06-19 ~ 2026-06-20) - PM Hermes 收口

> **作者**: Hermes PM (V4-V9) + codex-cli PM (V10)
> **承接**: V3+ P0 (SelfEvolution 鸡) + P1 (Darwin 自长 蛋) + P2 (plugin 装新器官)
> **本节**: 续期到 v9.2 (60+ cycle, 1199/1199 tests, 7 production plugins)

### v4 cycle 0-5 (vector memory + 6-skill self-evolution)

| Cycle | SHA       | What                                                              |
| ----- | --------- | ----------------------------------------------------------------- |
| V4 c0 | `a04c3d9` | OpenClaw workspace fix (3 agents pointed at empty side repos)     |
| V4 c1 | `8cf2bf0` | vector memory DI seam — fakeembed default, 1005/1005 tests        |
| V4 c2 | `3e8f8e9` | head/tail/wc e2e — 1000/1000 tests (integer gate milestone)       |
| V4 c3 | `0a73413` | deepseek R1 reasoning e2e — 1005/1005, R1 surface parity          |
| V4 c4 | `242f754` | provider.embed() + vector end-to-end — 1018/1018, P1-B2 milestone |
| V4 c5 | `b6984a7` | 6-skill Darwin self-evolution e2e — 1027/1027                     |

### v5 cycle 1-2 (feishu adapter)

| Cycle | SHA       | What                                                        |
| ----- | --------- | ----------------------------------------------------------- |
| V5 c1 | `aa0c439` | feishu adapter send (real IM v1 wire + tenant_access_token) |
| V5 c2 | `9267ff8` | feishu adapter parse + verify round-trip                    |

### v6 cycle 1-2 (feishu-notify plugin + feishu-card skill)

| Cycle | SHA       | What                                                         |
| ----- | --------- | ------------------------------------------------------------ |
| V6 c1 | `d260048` | plugin/feishu-notify (Darwin evolution events → feishu push) |
| V6 c2 | `4a07d1a` | skill: feishu-card (interactive push) + cron scheduler seed  |

### v7 cycle 1-2 (feishu-card skill shape + cron)

| Cycle | SHA       | What                                                           |
| ----- | --------- | -------------------------------------------------------------- |
| V7 c1 | `23e3446` | feishu-card skill execute shape (single-key `{output:string}`) |
| V7 c2 | `eb567dc` | cron scheduler + audit heartbeat plugin (cron-tick → audit)    |

### v8 cycle 1-2 (qwen R1 + housekeeping)

| Cycle | SHA       | What                                                        |
| ----- | --------- | ----------------------------------------------------------- |
| V8 c1 | `aeb755a` | qwen R1 reasoning e2e closure (DashScope OpenAI-compatible) |
| V8 c2 | `c39b32a` | provider test imports + cron-audit theme + housekeeping doc |

### v9 cycle 1-2 (cross-night delivery + feishu-notify loader coverage)

| Cycle | SHA       | What                                                   |
| ----- | --------- | ------------------------------------------------------ |
| V9 c1 | `cf231b3` | docs/memory/2026-06-19 (cross-night delivery)          |
| V9 c2 | `28552ea` | feishu-notify loader.init() lifecycle e2e (7 case A-G) |

### v10.1-v10.3 (codex-cli PM handoff: observability + refactor + housekeeping)

| Cycle | SHA       | What                                                                       |
| ----- | --------- | -------------------------------------------------------------------------- |
| V10.1 | `b32e7b7` | audit plugin all-12 events + catalogue worktree isolation (observability)  |
| V10.2 | `9aa3f72` | provider/protocol/\_shared.js (qwen/deepseek/gemini refactor, ~200 行消重) |
| V10.3 | `e4a7b42` | V9.2 reviewer 4-item housekeeping (feishu-notify e2e tightening)           |

### 续期后状态 (2026-06-20)

| Dimension          | v3+ P0 收口时 | v4-v10 续期后                   |
| ------------------ | ------------- | ------------------------------- |
| Tests              | 974/974       | 1199/1199 (+225)                |
| Providers          | 6/6           | 12/12 (+6)                      |
| Skills             | 6/6           | 7/7 (+1)                        |
| Plugins            | 5/5           | 7/7 (+2)                        |
| Production plugins | 5             | 7 (+feishu-notify, +cron-audit) |
| HEAD               | `b9f725b`     | `e4a7b42`                       |
| 仓库卫生           | 138 files     | 165 files (+27)                 |

### 续期 philosophy 一致性 (v4-v10 全部遵循 v2 哲学)

- **v4** 走 P1 第二阶段：Darwin 真的用 SelfEvolution 给自己长 vector memory + 6 skill
- **v5** 扩到 platform adapter：feishu 让 Darwin 有了外发消息能力
- **v6** 走 P2 plugin 装新器官：feishu-notify plugin 让 Darwin 自家事件能外推到飞书
- **v7** 走 skill + cron：feishu-card skill + cron 调度（Darwin 自己装调度器）
- **v8** 走 R1 reasoning surface：qwen R1 reasoning 跟 deepseek R1 平齐（provider 横扩）
- **v9** 走 loader coverage：feishu-notify 7 状态机覆盖（plugin 装器官后的质量）
- **v10** 走 observability + 重构：audit log 全事件 + catalogue.log 治本 + provider 重构（治理债清理）

**v3+ P0/P1/P2 全部收口；v4-v10 续期从 974 tests 涨到 1199 tests，5 plugins 涨到 7 plugins，6 providers 涨到 12 providers —— 全部由 Darwin 用 SelfEvolution 自长 + PM 审 + reviewer 复核**。

### v4-v10 reviewer backlog (建议 V11+ 收口)

V8.1 S2 (extractQwenReasoningContent + extractDeepSeekReasoningContent 抽取) → V10.2 收口 ✓
V9.2 4-item housekeeping → V10.3 收口 ✓
V3 P1 ConfigResolver YAML gap → 留 V10.7 (1 cycle, fix ConfigResolver 读 YAML)
V10.4 当前正在做：README + V3_ROADMAP V4-V9 续期 (本节 ✓)

## 链接

- **v2 收官**：[V2_LAUNCH_NOTE.md](./V2_LAUNCH_NOTE.md)
- **v2 规划**：`~/.openclaw/workspace/research/darwin-v2-implementation-plan-2026-06-06.md`
- **v1 教训**：`docs/ANTI_PATTERNS.md`（SelfEvolution 设计必读 A-2/B-2/F-5~F-9）
- **v2 5 大决策**：`docs/PR_DESIGN_23_24_25.md` + `docs/PR_DESIGN_21_SKILL_LOADER.md` + `docs/PR_DESIGN_26_OPENCLAW_COMPAT.md`
- **EventBus 事件名（含 evolution:\*）**：v2 规划 §5 / `core/events.js`
