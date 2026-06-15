# Darwin v2 启动期 收官 Note - 2026-06-15

> **作者**: Hermes PM · **Reviewer**: darwin-reviewer (PR-27 独立审查) · **状态**: ✅ v2 可上线

---

## 一句话

**v2 = 骨架 + 接口契约 + 端到端可跑通 demo**。肉由 v3+ Darwin self-evolution 补。

---

## 路线图收官全景（实际 8 PR / 规划 12 PR）

规划 12 PR（darwin-v2-implementation-plan-2026-06-06）→ 实际 8 PR（简化版）。**8 PR 全部 PASS**（PR-27 review 验证）。

| #   | PR         | 模块                        | 关键 commit           | 关键产出                                               | 状态 |
| --- | ---------- | --------------------------- | --------------------- | ------------------------------------------------------ | ---- |
| 1   | **PR-A**   | core/skill-registry         | `829629b`             | v1-to-v3 note + PII warning                            | ✅   |
| 2   | **PR-21a** | core/skill-loader           | `12a29ff`             | skill loader + 4 trigger rules + priority 排序         | ✅   |
| 3   | **PR-21b** | core/skill-watcher          | `b98a69f`             | fs.watch + 150ms debounce + error recovery             | ✅   |
| 4   | **PR-24**  | core/tool-catalog           | `a973653`             | 3 meta tool (search/describe/call) + 4 错误码          | ✅   |
| 5   | **PR-25**  | core/tool-loop              | `7ea16bc`             | MAX_TOOL_ROUNDS=5 + retry/fallback/deadlock-detect     | ✅   |
| 6   | **PR-26a** | core/openclaw-skill-adapter | `fc04fae`             | OpenClaw L1+L2 → Darwin SkillEntry 适配                | ✅   |
| 7   | **PR-26b** | core/skill-matcher-v2       | `8daad5a`             | 4 trigger type (exact/substring/regex/command-prefix)  | ✅   |
| 8   | **PR-27**  | 集成 + e2e                  | `a06ccb2` + `1a7be87` | PR-26 集成到 loader+watcher，1 行 import 切 matcher-v2 | ✅   |

**vs 规划偏差**：规划 12 PR 含 PR 1（CI）+ PR 11（demo 端到端）+ PR 12（docs/ADR），**实际未单独立 PR**——CI 配置在 PR-A/21a 之间落地，demo 整合在 PR-27，docs 持续滚动。

---

## 5 大核心决策兑现（v2 §3 拍板）

| #   | 决策                          | v2 落地证据                                                                                                                                                                     |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | **EventBus 单向通信**         | `core/event-bus.js`（119 行）+ `core/events.js`（113 行，**29 个事件名常量**），跨模块零业务 import（PR-23/24/25/26 全部走 `bus.on('*:after')` 订阅）                           |
| ②   | **ConfigResolver 唯一入口**   | `core/config-resolver.js`（190 行，三层 YAML + `${VAR}` placeholder），`adapter-feishu` / `provider-anthropic` 全部走 `ConfigResolver.get(module)`，零 `process.env.*` 业务直读 |
| ③   | **Provider 单文件单路径**     | `provider/{anthropic,openai-compatible}.js` 唯一文件 + `provider/protocol/` 独立目录；规划阶段的 "v2 不写具体 provider" 落地部分（anthropic + openai 都做了，但仍在骨架层）     |
| ④   | **Tool Call 协议层独立**      | `provider/protocol/{openai-compatible,anthropic-protocol,tool-call}.js` 独立模块，PR-25 tool loop 消费 protocol 层 0 改动                                                       |
| ⑤   | **TDD 强制 + 编码规则 CI 化** | 8 PR 全部"先失败测试 → 再实现"；`npm run size-check` 78/78 files < 1000 行；`npm run lint` 0 error / 0 warning                                                                  |

---

## 关键 trick 落地证据（v2 §8 拍板）

| Trick                       | v2 证据                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **单文件 < 1000 行**        | `npm run size-check` 78/78 files 通过；**最大文件** = `core/skill-loader.js` **496 行**（接近 500 但 under 1000）    |
| **MAX_TOOL_ROUNDS=5**       | `core/tool-loop.js:264` 行文件 + 常量硬上限 5；预留 5/10/20 三档配置（PR_DESIGN §10 #2）                             |
| **TDD 强制**                | PR-21/23/24/25/26/27 每个 PR 必先写失败测试 + `npm test` 全过才能 commit；**实测 340/340 pass**（PR-27 review）      |
| **Provider 单文件**         | `provider/anthropic.js`（198 行）+ `provider/openai-compatible.js`（256 行），双份实现零                             |
| **ConfigResolver 唯一入口** | `core/config-resolver.js` 含三层合并（代码/用户/凭据），所有 config 走 `ConfigResolver.get(module)`                  |
| **Tool call 协议独立**      | `provider/protocol/tool-call.js`（131 行）+ `provider/protocol/anthropic-protocol.js`（344 行），独立 module         |
| **散点活分类法**            | ANTI_PATTERNS B-2 节拍板 P0/P1/P2/P3 分类，PR 6/12b/13b 教训驱动 F-7/F-9 弹性规则                                    |
| **★ 骨架 only，不写实现**   | v2 启动期真不写 builtin skill/tool/memory 后端；memory backend (filesystem/sqlite) 在 demo 之外，**v3+ Darwin 自长** |
| **★ 接口契约稳定**          | `IProvider` / `ITool` / `ISkill` / `IMemory` 4 大契约 v2 启动期一次定稿，破坏性变更走 ADR（暂未单独立 ADR 文件）     |

---

## 质量基线（PR-27 review 实测）

- **测试**：340/340 pass（114 suites）—— PR-27 收官实测
- **size-check**：78/78 files < 1000 行（PM brief 写 76，实测 +2 e2e fixture，**非 fix 项**）
- **lint**：0 errors / 0 warnings（eslint 静默退出）
- **commit 规范**：全 `feat(core):` / `docs(core):` / `docs(design):` lowercase + scope，commitlint 通过
- **单文件最大**：`core/skill-loader.js` **496 行**（接近 500 弹性上限，但 under 1000 硬上限）
- **代码总量**：5,549 行 JS（core 33 文件 + lifecycle + provider + memory）

---

## 与 v2 规划偏差（实事求是）

- **PR 数量**：实际 8 PR（vs 规划 12 PR）—— 简化版，CI/demo/docs 滚动到 PR-A/27
- **Provider 实现**：规划"v2 不写具体 provider"，**实际写了** anthropic + openai-compatible（demo 端到端跑通必需）—— 边界守住："不写 builtin skill/tool"，provider 必须写否则跑不通
- **Memory 后端**：filesystem（186 行）+ sqlite（245 行）**双实现**做了，**未在 v2 规划内**——同样 demo 必需
- **IMPLEMENTATION_PLAN.md**：规划要求 1:1 抄进 `docs/IMPLEMENTATION_PLAN.md`，**暂未抄**（规划原件在 `~/.openclaw/workspace/research/darwin-v2-implementation-plan-2026-06-06.md`）
- **docs/ADR/**：规划要求 5 个 ADR，**暂未建**目录（5 大决策已在本 Note 第 2 节兑现表 + 5 个 PR_DESIGN 文档中沉淀）
- **PR 22 (context-loader L6)**：实现落到 PR-23 `core/skill-registry.js` 单文件（`829629b`），**未单独立 PR**——简化为 PR-A
- **demo 端到端**：规划 PR 11 单独立，**实际整合到 PR-27** e2e fixture（tmpdir + L1/L2/darwin 混目录 6 cases）

---

## 收官时刻 v2 状态

- **可上线**：✅ — PR-27 review 通过，5 硬标准全过
- **核心能力**：
  - LLM 对话（anthropic + openai-compatible 双 provider）
  - Skill 触发注入（v2 + OpenClaw L1/L2 兼容）
  - Tool Call Loop（5 轮硬上限 + retry/fallback/deadlock-detect）
  - Tool Catalog（3 meta tool + 4 错误码）
  - Memory 持久化（filesystem + sqlite）
- **CLI 8 个 sub-commands**：`chat` / `repl` / `config add|show` / `plugin add|list` / `memory set|show` / `help`
- **v3+ 起步**：SelfEvolution 完整实现（v2 规划 §10 拍板最高优先级）
- **哲学延续**：骨架 only，肉 Darwin 长

---

## 链接

- **路线图规划**：`~/.openclaw/workspace/research/darwin-v2-implementation-plan-2026-06-06.md`（360 行骨架哲学原文）
- **PR-27 收官报告**：`/tmp/PR27_REVIEW.md`（darwin-reviewer 独立审查）
- **v1 教训**：`docs/ANTI_PATTERNS.md`（933 行，26 条反模式，A-E 大类 + v2 启动期 F-1~F-9）
- **PR 设计文档**：
  - `docs/PR_DESIGN_21_SKILL_LOADER.md`（skill loader 契约）
  - `docs/PR_DESIGN_23_24_25.md`（matcher + tool catalog + tool loop）
  - `docs/PR_DESIGN_26_OPENCLAW_COMPAT.md`（OpenClaw L1+L2 + matcher-v2）
- **用户文档**：`docs/USAGE.md`（5 分钟跑起来 3 步走）
- **OpenClaw 调研**：`docs/OPENCLAW_PROMPT_REFERENCE.md`（1018 行，v2 PR-A 拍板的参考材料）
- **配套**：[V3_ROADMAP.md](./V3_ROADMAP.md)（v3+ SelfEvolution 路线图）
