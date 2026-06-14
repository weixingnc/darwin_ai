# v2 PR-21 — SKILL Loader + fs.watch 热更新

> 设计稿 v0.1（2026-06-15）· darwin-architect 响应 Hermes PM PR-Design 02
> 对齐：[OPENCLAW_PROMPT_REFERENCE.md](./OPENCLAW_PROMPT_REFERENCE.md) §3.5/§8.2 + [PR_DESIGN_23_24_25.md](./PR_DESIGN_23_24_25.md)
> 前置：`core/skill-registry.js`（PR-23 sha `829629b`）· 约束：单文件 < 1000 / 单 PR < 500 / OpenClaw 只学概念不抄代码
> 后续：PR-26（OpenClaw SKILL L1+L2 兼容）依赖本设计

---

## §0 TL;DR（5 句拍板）

1. **拆 2 个 PR**：`core/skill-loader.js`（~280）+ `core/skill-watcher.js`（~120）——PR-21a + PR-21b 各 < 500 行。
2. **frontmatter schema**：YAML，`name` 必填，其余 7 字段可选；`triggerType` 默认 `substring`，**完全兼容 PR-23 registry 已有的 5 个 skill**。
3. **4 个触发规则** = `exact` / `substring` / `regex` / `command-prefix`，互斥；`priority` 默认 50 用于跨 skill 冲突 + 同 name 重复覆盖。
4. **fs.watch 非递归** + debounce **150ms** + 永不抛；损坏 SKILL = warn + skip，**不致命**（darwin 永不为 skill 系统崩）。
5. **PR-26 兼容预留**：`SkillEntry` 是**纯对象 v2 自有格式**；OpenClaw `SKILL.md` 解析留给 PR-26 `openclaw-skill-adapter.js` —— PR-21 不做 OpenClaw frontmatter 解析，避免单 PR 复杂度爆炸。

---

## §1 SKILL 文件格式

### 1.1 物理形态

```
skills/
├── weather.md             # 单文件 = 一个 SKILL
├── browser.md
└── coding/                # 嵌套子目录, watcher 仅扫一层（见 §4.3）
    ├── python.md
    └── rust.md
```

### 1.2 frontmatter schema（YAML）

```yaml
---
name: weather # 必填, [a-z0-9-]+, ≤ 32 字, 全 registry 唯一
version: 1.0.0 # 可选, semver, 默认 '0.0.0'
triggers: # 可选, 数组, 默认 []
  - 天气
  - weather
triggerType: substring # 可选, 默认 'substring', 见 §3
hint: 调用 weather tool... # 可选, 默认 = frontmatter 后正文前 200 字
priority: 50 # 可选, 0-100, 默认 50
source: local # 可选, 默认 'local', PR-26 加 openclaw-l1/l2
path: ./skills/weather.md # 自动注入, 用户不写
---
# SKILL 正文（注入 hint 兜底 + 给 LLM 阅读）
```

### 1.3 字段约束表

| 字段          | 类型     | 必填 | 默认            | 约束                                                         |
| ------------- | -------- | ---- | --------------- | ------------------------------------------------------------ |
| `name`        | string   | ✅   | —               | `[a-z0-9-]+`, ≤ 32 字, 唯一                                  |
| `version`     | string   | ❌   | `'0.0.0'`       | semver `\d+\.\d+\.\d+`, 否则 warn                            |
| `triggers`    | string[] | ❌   | `[]`            | 每条 ≤ 64 字, 空数组 = 不参与匹配                            |
| `triggerType` | enum     | ❌   | `'substring'`   | `exact`/`substring`/`regex`/`command-prefix`（互斥, 见 §3）  |
| `hint`        | string   | ❌   | 正文前 200 字   | ≤ 2000 字; 空 = 不进 L6 注入                                 |
| `priority`    | number   | ❌   | `50`            | `0 ≤ p ≤ 100`, 整数                                          |
| `source`      | enum     | ❌   | `'local'`       | PR-21 只识别 `'local'`, PR-26 加 `openclaw-l1`/`openclaw-l2` |
| `path`        | string   | ❌   | loader 自动注入 | 绝对路径, 用户不写                                           |

---

## §2 API 契约

### 2.1 `core/skill-loader.js`（PR-21a）导出 4 函数 — **永不抛**

| 函数                                                     | 作用                                               |
| -------------------------------------------------------- | -------------------------------------------------- |
| `parseSkillFile(filePath, content) → SkillEntry \| null` | 纯函数, 无 I/O, 损坏返 null                        |
| `loadAll(skillsDir, registry, opts?) → LoadResult`       | 启动扫描, 损坏计入 `skipped[]`                     |
| `registerSkill(registry, entry) → { ok, errorCode? }`    | 写 registry（覆盖语义）, 重复 name 返 `{ok:false}` |
| `unregisterSkill(registry, name) → boolean`              | 删一条, 找不到返 false                             |

### 2.2 `core/skill-watcher.js`（PR-21b）导出 2 函数 — **永不抛**

| 函数                                                       | 作用                         |
| ---------------------------------------------------------- | ---------------------------- |
| `watchSkillsDir(skillsDir, registry, opts?) → WatchHandle` | fs.watch + debounce + 热更新 |
| `closeWatch(handle) → void`                                | 关闭 watcher（进程退出时调） |

### 2.3 JSDoc（核心签名）

```js
/** parseSkillFile: 纯函数, 损坏返 null.
 *  SkillEntry = { name, version, triggers, triggerType, hint, priority, source, path, body } */
export function parseSkillFile(filePath, content) {
  /* ... */
}

/** loadAll: 扫描目录, 损坏 skip + warn.
 *  LoadResult = { loaded: string[], skipped: Array<{path, reason}>, total: number } */
export function loadAll(skillsDir, registry, opts) {
  /* ... */
}

/** watchSkillsDir: fs.watch + debounce 150ms + 热更新.
 *  WatchHandle = { close(): void, paused: boolean, error?: Error }
 *  Event map: 'rename'+exists→parse+register; 'rename'+gone→unregister;
 *             'change'→parse+register; 'error'→warn+paused=true. */
export function watchSkillsDir(skillsDir, registry, opts) {
  /* ... */
}
```

---

## §3 触发规则 4 选 1

### 3.1 4 个 triggerType 语义（大小写敏感）

| type                        | 匹配逻辑                                                   | 示例                                       |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `exact`（默认 `substring`） | `text === trigger`（trim 后）                              | `['/help']` → "/help" 命中                 |
| `substring`（默认）         | `text.includes(trigger)`                                   | `['天气']` → "北京天气" 命中               |
| `regex`                     | `new RegExp(trigger).test(text)`                           | `['^/cmd\\s+(\\w+)$']` → "/cmd build" 命中 |
| `command-prefix`            | `text.trim().startsWith(trigger)`（trigger 必须 `/` 开头） | `['/git']` → "/git commit" 命中            |

### 3.2 PR-23 substring 向后兼容（关键）

PR-23 `_firstMatchingTrigger`（`core/skill-registry.js:96-110`）已用 `trigger.toLowerCase()` 做 case-insensitive。**PR-21 parseSkillFile 内部统一小写 `triggers`** → PR-23 `trigger.toLowerCase()` 是 no-op → **不破坏 PR-23 已有的 5 个 skill**（idempotent 兼容）。

### 3.3 优先级与冲突解决

`matchSkills`（PR-23）**不感知 priority**（纯函数）；PR-21 `loadAll` 内部按 priority 降序排序后插入 registry → **JS Map insertion order = priority 降序** → PR-23 "先注册先得"自然吃到 priority 排序结果。

| 场景                                               | 规则                                                                        | 责任                 |
| -------------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| **跨 skill 冲突**（多条命中同 turn）               | priority 降序 → 同 priority 按 registry 插入顺序 → 截到 `skillTriggerMax=2` | `loadAll` 排序后插入 |
| **同 name 重复**（A+B 都 `name: weather`）         | 新更高 → 覆盖 + warn；新同/低 → 保留旧 + 新入 `skipped[]`                   | `registerSkill`      |
| **多 triggerType**（一个 skill 同时声明多个 type） | 禁止：frontmatter 只能 1 个, 多余 warn + 忽略                               | `parseSkillFile`     |
| **regex 非法**                                     | 降级到 substring + warn                                                     | `parseSkillFile`     |
| **command-prefix trigger 不以 `/` 开头**           | 该 trigger 降级到 substring + warn                                          | `parseSkillFile`     |

---

## §4 fs.watch 行为

### 4.1 debounce = 150ms（默认）

编辑器"写临时+rename+写正式"三连击需 ~150ms 合并（< 50ms 易重 parse）。每次 `rename`/`change` reset **同文件** timer（不并发 parse）；**跨文件不合并**（A/B timer 独立）。

### 4.2 错误恢复（永不抛）

```js
try {
  watcher = fs.watch(skillsDir, { recursive: false }, listener);
} catch (err) {
  // ENOENT / EACCES → log error, 返 { close: noop, paused: true, error }, 不抛
  logger.error('skill-watcher: cannot watch ' + skillsDir + ': ' + err.message);
  return { close: () => {}, paused: true, error: err };
}
watcher.on('error', (err) => {
  // runtime error → warn + paused=true（不重试自愈, PR-26 再说）
  logger.warn('skill-watcher: runtime error, paused: ' + err.message);
  handle.paused = true;
});
```

### 4.3 递归 vs 非递归 + 过滤

- **v1 默认非递归**（`opts.recursive=false`）—— 只扫 `skills/*.md` + `skills/*/SKILL.md`（子目录只一层）。
- `recursive: true` v1 **不接受**（Linux fs.watch 不支持）—— **留给 PR-26**。
- **过滤**：跳过 `node_modules` / `.git` / 点开头目录（`opts.ignore` 默认 `['node_modules', '.git']`）。

---

## §5 错误边界

### 5.1 单文件损坏 → 不致命（计入 `LoadResult.skipped[]`）

| 损坏类型                                                            | 处理                          | loaded? |
| ------------------------------------------------------------------- | ----------------------------- | ------- |
| 缺 frontmatter / frontmatter 空 / 缺 name / name 格式错 / YAML 失败 | warn + skip                   | ❌      |
| `triggerType` 非法 / `regex` 编译失败                               | 降级到 `substring` + warn     | ✅      |
| `hint` >2000 字 / `body` >50KB                                      | 截断 + warn                   | ✅      |
| `priority` 越界（<0 或 >100）                                       | clamp + warn                  | ✅      |
| 重复 name + priority ≤ 已注册                                       | warn + skip（不覆盖，保留旧） | ❌      |
| 重复 name + priority > 已注册                                       | warn + 覆盖                   | ✅      |

### 5.2 目录损坏 → 也不致命

| 情况                        | 处理                                               |
| --------------------------- | -------------------------------------------------- |
| `skillsDir` 不存在 / 不可读 | warn + 返 `{loaded:[], skipped:[], total:0}`       |
| 目录里**全部**文件损坏      | warn + 返同上 —— **darwin 仍可启动**, 只是没 skill |
| `loadAll` 自身抛（不应该）  | 这是 bug, loader 必须 fix（**不靠 catch 兜**）     |

### 5.3 watcher 损坏 → 不致命（见 §4.2）

**关键不变量**：darwin 进程**永远不**因为 skill 系统坏而崩。skill 是"增强"不是"依赖"。

---

## §6 与 SkillRegistry 集成（loadAll 合约）

### 6.1 调用流程

```text
darwin 启动
  └─ context-loader.js (PR-22) 初始化
       └─ skill-loader.loadAll(skillsDir, registry, opts)
            ├─ fs.readdirSync(skillsDir)
            ├─ for each *.md:
            │    ├─ content = fs.readFileSync(absPath, 'utf8')
            │    ├─ entry = parseSkillFile(absPath, content)   // 纯函数
            │    └─ registerSkill(registry, entry)              // 写 registry
            └─ return { loaded, skipped, total }
       └─ skill-watcher.watchSkillsDir(skillsDir, registry, opts)
            └─ fs.watch(...) + debounce 150ms
                 └─ on event: parseSkillFile + register/unregister
```

### 6.2 合约关键不变量

| 不变量                                                              | 谁保证                         |
| ------------------------------------------------------------------- | ------------------------------ |
| `loadAll` 结束后 `registry.size === LoadResult.loaded.length`       | PR-21                          |
| `registry.entries()` 顺序 = `priority` 降序                         | PR-21 `loadAll` 内部排序后插入 |
| `entry.name === Map key`（registry 是 `Map<name, entry>`）          | PR-21 `registerSkill`          |
| `matchSkills`（PR-23）零改动可消费 PR-21 产出                       | PR-21 保证 entry 字段名兼容    |
| 不修改 `core/skill-registry.js` / `core/context-loader.js` 任何一行 | PR-21 边界约束                 |

### 6.3 entry 字段对齐表（核心兼容点）

| PR-23 期望字段                   | PR-21 SkillEntry 字段 | 对齐策略                                                                                                                    |
| -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `entry.triggers: string[]`       | `triggers: string[]`  | ✅ 完全一致（PR-21 parse 时统一小写, PR-23 二次 lowercase 是 idempotent）                                                   |
| `entry.systemPromptHint: string` | `hint: string`        | ⚠️ 字段名不同 —— PR-21 `registerSkill` **同时写双键**：`{...hint, systemPromptHint: hint}`, **PR-23 纯函数 0 改动即可消费** |
| `entry.name: string`             | `name: string`        | ✅ 完全一致                                                                                                                 |

**双键技巧**：`registerSkill` 写入时同时设 `hint` + `systemPromptHint`（值同）。PR-21 内部统一读 `hint`，PR-23 内部统一读 `systemPromptHint`，**互不污染**。

---

## §7 测试规约（4 文件 ≥ 24 case）

### 7.1 Unit（`tests/core/skill-loader.test.js`，12 case）

parseSkillFile：缺 frontmatter / frontmatter 空 / 缺 name / name 含大写或 >32 字 → 返 null（case 1-5）；默认 triggerType='substring' / 'exact' / 'regex' 非法 → 降级（6-8）；priority 越界 clamp（9-10）；hint >2000 截断（11）；正常文件 entry 含全字段 + body（12）。

### 7.2 Integration（`tests/core/skill-loader.integration.test.js`，6 case）

loadAll：3 OK / 2 OK + 1 损坏 / priority 排序 [80,50,30] / 重复 name (D p=80 胜 E p=50) / `matchSkills` 消费 PR-21 registry 仍 case-insensitive / skillsDir 不存在返空不抛。

### 7.3 Watcher（`tests/core/skill-watcher.test.js`，6 case）

watch + mock 改 / debounce 100ms 内 3 次只 1 reparse / 删文件触发 unregister / 改坏保留旧 entry / close() 后不触发 / 不存在目录返 paused=true。

### 7.4 边界用例

YAML 失败（不闭合/tab/key 重复）；frontmatter 空对象 `--- \n---` 或数组（正文当 frontmatter）；文件名 ≠ name / 含空格中文；triggers 空字符串/非字符串/超 100 条；daemon 1 小时内存不增长（`process.memoryUsage()` 拍快照）。

---

## §8 PR 拆分（单 PR ≤ 500 行红线 → 拆 2 PR）

| PR         | 文件                               | 行数 | 内容                                                       | 前置          |
| ---------- | ---------------------------------- | ---- | ---------------------------------------------------------- | ------------- |
| **PR-21a** | `core/skill-loader.js`             | ~280 | parseSkillFile + loadAll + registerSkill + unregisterSkill | —             |
|            | `tests/core/skill-loader.test.js`  | ~100 | 12 unit + 6 integration                                    | —             |
| **PR-21b** | `core/skill-watcher.js`            | ~120 | watchSkillsDir + closeWatch                                | PR-21a merged |
|            | `tests/core/skill-watcher.test.js` | ~50  | 6 watcher case                                             | PR-21a merged |

**PR-26 留给未来**（`core/openclaw-skill-adapter.js` ~150 行，解析 OpenClaw SKILL.md L1/L2 → 产 PR-21 SkillEntry，PR-21 不做避免单 PR 复杂度爆炸）。

**不动**：`core/skill-registry.js`（PR-23）/ `core/context-loader.js`（PR-22）/ `docs/PR_DESIGN_23_24_25.md`（只读）/ 其他已有文件。

---

## §9 行号对照（每个函数预期落在哪几行）

### PR-21a — `core/skill-loader.js`（预计 ~280 行）

| 函数 / 区块                                            | 预期行号  | 行数 |
| ------------------------------------------------------ | --------- | ---- |
| 模块注释 + 5 个 const（`MAX_NAME_LENGTH=32` 等）       | L1-L30    | 30   |
| `parseSkillFile`（frontmatter 切分 + YAML + 字段校验） | L31-L130  | 100  |
| `_validateEntry`（internal, priority clamp 等）        | L131-L170 | 40   |
| `loadAll`（readdir + 排序 + 批量 register）            | L171-L230 | 60   |
| `registerSkill`（priority 冲突检测 + 写双键）          | L231-L260 | 30   |
| `unregisterSkill`                                      | L261-L280 | 20   |

### PR-21b — `core/skill-watcher.js`（预计 ~120 行）

| 函数 / 区块                                      | 预期行号  | 行数 |
| ------------------------------------------------ | --------- | ---- |
| 模块注释 + const（`DEFAULT_DEBOUNCE_MS=150` 等） | L1-L15    | 15   |
| `_debounce(handler, ms)` helper                  | L16-L40   | 25   |
| `watchSkillsDir`（fs.watch + 事件映射）          | L41-L100  | 60   |
| `closeWatch`                                     | L101-L120 | 20   |

### 引用（PR-23 现成文件）

| 现有函数 / 字段                        | 文件                     | 行号         | PR-21 怎么用                                                                    |
| -------------------------------------- | ------------------------ | ------------ | ------------------------------------------------------------------------------- |
| `createRegistry()`                     | `core/skill-registry.js` | **L33-L35**  | PR-21 `loadAll` 第二参数来源                                                    |
| `matchSkills({ text, registry, max })` | `core/skill-registry.js` | **L57-L70**  | **不调它**（PR-23 L6 调），但**保证** PR-21 产出 entry 能被消费                 |
| `_firstMatchingTrigger(entry, needle)` | `core/skill-registry.js` | **L96-L110** | PR-21 必须保证 `entry.triggers` 已小写（让 `trigger.toLowerCase()` idempotent） |
| `SKILL_MATCH_SOURCE_REGISTRY`          | `core/skill-registry.js` | **L25**      | PR-21 写 `entry.source` 时用这个常量                                            |

---

## §10 PR-26 兼容性预留

### 10.1 PR-21 给 PR-26 留的扩展点

| 扩展点                         | PR-21 怎么留                                 | PR-26 怎么用                          |
| ------------------------------ | -------------------------------------------- | ------------------------------------- |
| 多 triggerType                 | `entry.triggerType` enum 4 选 1              | OpenClaw L2 用 `command-prefix`       |
| `source` 字段                  | enum `'local'\|'openclaw-l1'\|'openclaw-l2'` | adapter 写 `openclaw-l1/l2`           |
| `hint`/`systemPromptHint` 双键 | `registerSkill` 同时写两键                   | adapter 直接复用                      |
| `path` 自动注入                | loader 写 `entry.path`                       | adapter 也写, watcher 用它定位        |
| `recursive: true`（未实现）    | `opts.recursive` 透传（v1 默认 false）       | PR-26 实现 recursive watcher          |
| `body` 字段                    | `entry.body: string`                         | OpenClaw L2 description 长文本走 body |

### 10.2 PR-21 故意不做（留给 PR-26）

解析 OpenClaw `SKILL.md` L1/L2 frontmatter（避免单 PR 复杂度爆炸）/ `recursive: true`（Linux fs.watch 不支持）/ 文件 hash 检测（v1 mtime 够）/ skill 依赖 `requires`（v2 没需求）/ `~/.darwin/skills/` 全局加载（v3 再说）。

### 10.3 entry 字段命名（PR-26 映射）

| v2 字段                     | OpenClaw → PR-26 映射                    |
| --------------------------- | ---------------------------------------- |
| `name`                      | OpenClaw `name`                          |
| `triggers`                  | OpenClaw 别名（PR-26 映射）              |
| `triggerType`               | 无 → PR-26 默认 `'command-prefix'`       |
| `hint` / `systemPromptHint` | OpenClaw `description`                   |
| `priority`                  | 无 → PR-26 默认 50                       |
| `source`                    | PR-26 写 `'openclaw-l1'`/`'openclaw-l2'` |
| `path`                      | 无 → PR-26 adapter 注入                  |

### 10.4 与 PR-23/24/25 引用对照

matchSkills 是纯函数（`skill-registry.js:57-70`）/ systemPromptHint 字段（`:18-22`）/ skillTriggerMax=2（`PR_DESIGN_23_24_25.md:9-10`）/ 不改 PR-23（`:30`）/ 错误码字典（`:194-203`，**PR-21 不引入新错误码**）/ OpenClaw 4 trigger type 灵感（`OPENCLAW_PROMPT_REFERENCE.md:131-148` §3.1-3.2 + §10）。

---

## §11 边界约束

**产出**：skill-loader.js (PR-21a ~280) + skill-watcher.js (PR-21b ~120) + 2 test 文件 (~150)。**不动**：skill-registry.js (PR-23 sha `829629b`) / context-loader.js (PR-22) / PR_DESIGN_23_24_25.md (只读)。**维护**：字段名变更**双键过渡**；`matchSkills` 签名变更需 PR-23 同步；OpenClaw 大版本升级后重读 §3.5/§8.2 校准 PR-26。

**END OF DESIGN v0.1**

> **致 Hermes PM**：PR-21 拆 2 PR（21a 解析 + 21b watcher），各 < 500 行。11 节齐全（schema/API/触发/watch/错误/集成/测试/拆分/行号/PR-26/边界），风格对齐 `PR_DESIGN_23_24_25.md`。**无实现代码**，PR-23 registry / PR-22 context-loader 零修改。`matchSkills` 纯函数契约由"registerSkill 写 hint + systemPromptHint 双键"保证，PR-23 零改动可消费 PR-21 产出。
