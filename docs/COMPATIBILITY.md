# DSH 兼容性矩阵

本仓库的目标兼容面是 **DeepSeek Harness `0.2.2-rc.1` – `0.2.2-rc.5`**；当前候选发布版本是插件版本
**`0.4.2-rc.2`**（6 个可发布包共用同一版本号；prerelease，CI 以 npm dist-tag `next` stage，维护者
approve 后公开）。稳定版 `latest` 当前为 **`0.4.1`**（2026-11-22 北京时间经 staged publish +
人工 approve 公开）；approve `0.4.2-rc.2` 后 `next` 指向本候选、`latest` 仍为 `0.4.1`，直到计划中
的稳定版 `0.4.2` 发布。`0.4.0`（2026-11-21 公开）与 `0.4.0-rc.1`（同日以 `next` 发布）是历史
版本。`0.4.2-rc.1`（2026-11-23 已 stage 但**未 approve、从未公开**；其 main `verify` 因一个看板
读取测试的时序 flake 失败）由本候选取代，其 staged 记录不得 approve。`0.4.2-rc.2` 只是
**插件版本**，**不代表 DSH 0.4.2**——DSH 兼容面与
`engines.dsh` 都不变。6 个可发布包的
`engines.dsh` 均为 `>=0.2.2-rc.1 <0.3.0`（根 `package.json` 是 private 包，不声明
`engines.dsh`，只声明 `engines.node`），所有
`@deepseek-ai/dsh-*` peer 使用同一范围；本地 devDependencies 与编译基线仍固定 rc.1，用最旧 API
做类型检查，本机运行验证使用安装版 rc.5。board 加固不使用 0.2.3-only API，兼容范围保持
`>=0.2.2-rc.1 <0.3.0`。

## 契约

- DSH loader 只按 `engines.dsh` 判定插件兼容性；peer 范围供 profile 的 pnpm 检查使用。
- `0.2.2-rc.5` 落在现有 semver 范围内，**无需改 `engines.dsh` 或 peer 范围**。
- 各 rc 的能力差异：
  - `agent_teams` 从 rc.2 起可用；rc.1 返回 `DEVLEAD_TEAM_UNAVAILABLE`，不创建 Session。
  - 可选 worktree 隔离需要 Host 组合实验性 worktree/forge 服务；rc.4 / rc.5 的完整 E2E
    覆盖 phase 2。
  - 与 DevLead 相关的 rc.4 差异是 DeepSeek 流式拒答的 LLM 错误码；DevLead 不分类该错误码。
  - rc.5 只改 web search provider 选择（见下）；DevLead 不读取或调用该 API。
  - 项目看板默认启用（无需配置）并使用 rc.1 typings 与 rc.5 安装版源码均存在的
    `@deepseek-ai/dsh-atomic-write`（`writeFileAtomic` / `withFileLock`）、
    `systemPrompt.context()` 和 `webserver/index-inject`；只读右栏使用同版本范围的
    `sidebarRightTabs` / `sidebarRight.openTab`、`sidebar.right.pane.tab`、
    `remote.workspaceFiles.stat/readBytes/changes` 与 `useWorkspaces` / `useSessions`。
    不依赖 0.2.3-only API，engines/peer DSH range 不变。默认路径派生自 active lead 的
    `SessionHeader.cwd`（`<cwd>/.dsh/devlead/board.json`），`boardPath` 仍是可选的绝对路径
    override（既有配置升级后行为不变）；没有 lead 时看板禁用（无 global、无面板）。派生路径还要求
    lead 记录的原始 workspace 根仍是已存在目录：缺失时 Host 以 `missing-workspace` 保持看板禁用
    （不重建目录、不写入、工具 `BOARD_DISABLED`），显式 override 则保持既有预创建语义。看板
    start/预创建失败只降级该功能（P2-2），不影响插件加载；同一 resolved 路径的下一次 lead 同步也会
    按需重试 `start()`。浏览器入口为 lead-only：tab/guide/header 只在屏幕上的 active lead Session
    出现，global 形状含 `leadSessionId` / `override`；恢复出来但已非合规 lead 的 board tab 在首次
    sync 即关闭。
- `plugin records`（`appendPluginRecord` / `PluginRecordMap`）：rc.1–rc.5 均存在；这是
  **experimental、调用方受限**的扩展点，不是公开契约，Session format migration 为
  best-effort（详见下节）。DevLead 的全部 durable 状态都依赖它。

## 实验性扩展点与 deprecated API 债务

### plugin records（全部 durable 状态的基础）

DevLead 的全部 durable 状态——`plugin:devlead/mode` / `watch` / `notification` / `report` /
`report-answer` / `reset`——都通过
`appendPluginRecord(session, type, payload)` 写入，并在
`@deepseek-ai/dsh-session/types` 的 `PluginRecordMap` 中声明。rc.1 与 rc.5 的原文一致
（`dsh-v0.2.2-rc.1` / `dsh-v0.2.2-rc.5` 的 `packages/core/session/README.md`
「Write experimental plugin records」）：

> `appendPluginRecord(session, type, data)` appends one plugin record for a package under
> `packages/experimental/`; ... **Plugins outside this repository must not call it either**,
> although no repository check can inspect them.

同一节还要求记录写入 `PluginRecordMap`，并说明该 map 是实验性包声明自身状态的机制；
`docs/subsystems/session.md`「Plugin records」重复了这一限定；
`docs/experimental-persistence-catalog.md` 写明这些记录不进入 `SessionEventMap`、persistence
schema 指纹或 compatibility history，且 format migrations retain them on a best-effort basis；
`packages/core/session/README.md`「Write experimental plugin records」末段也写明 Session format
migration keeps them on a best-effort basis。因此：

- rc.1–rc.5 都提供该 API，但它是 **experimental、调用方受限**的扩展点，不是公开稳定契约。
- 本仓库的使用是**务实 workaround**（第三方插件无法扩充仓库内生成的 `SessionEventMap`
  词表），**没有稳定性或迁移保证**。
- 若上游移除、收紧或改变 `appendPluginRecord` / `PluginRecordMap` / `pluginRecordOf`，
  DevLead 的 durable 状态可能降级为仅内存、部分不可恢复或完全不可恢复；不能假设升级后旧
  记录仍可无损读取。
- 升级 DSH 前必须跑下节「升级门禁」；不得以“rc.1–rc.5 都有”替代稳定性判断。
- 生产代码的唯一运行时入口是 `packages/devlead/src/record-api.ts`：init 探测两个导出，首次读/
  写异常转入 `degraded`；只有失败的那次 append 返回 `false`，read 返回 `undefined`，只 warning
  一次。degraded 时 `/devlead status` 与每个成功的 `/devlead ...` 视图都明示 memory-only。fold
  保持最后有效状态（仅当 reader 从未可用时才是默认状态），不写 `failure`、不冻结；writer-only
  缺失时健康 reader 仍读回既有 durable 状态。该降级只保证插件可加载与状态可见，**不提供 durable
  替代存储**；正常 API 路径仍由原记录语义与全部既有测试覆盖。

### 无关未知事件的 v4 JSONL 只读恢复

`sessionQuery.readSession()` 会 replay-validate 整份日志；因此一条与 DevLead 无关、未标 ignorable 的
旧插件事件也会让 Host 以 `SessionFormatUnsupportedError` 拒绝整份物理完好日志。核心扫描只对这条精确
错误启用 `session-log-recovery.ts`：通过 `sessionPersistence.stat().location` 取得后端确认的路径，读取
当前 `session.v4.jsonl[.zstd]` 的全部 frames 和 torn tail 中完整记录，再做严格 DevLead fold。该路径
不 import/inject 具体 JSONL 包、不新增 peer 依赖；zstd 使用 Node ≥24.9 已提供的 `node:zlib`。没有
`stat/location`、旧格式或其它后端时不猜测表示，维持原 fail-closed 行为。

这是针对 v4 物理格式的兼容 workaround，不替代 `readSession`，也不承诺迁移旧格式。并发修改、非连续
seq、header/listing 不一致、错误 inherited cut、压缩/JSON/UTF-8 损坏、非 ignorable DevLead 记录以及
严格 fold 失败都拒绝授权；恢复绝不写文件。UTF-8 使用 fatal decoder，是有意比 Host 的非 fatal
`Buffer.toString()` 更严格，不声称接受面完全相同。升级门禁需继续核对 v4 header/event framing、
sourceEventSeqs 区间、zstd 多帧与 torn-tail 语义及 unknown-event error taxonomy。

### F 替代方案（核心事件派生 mode/watch/reset）— no-go（2026-11-20）

2026-11-20 的一次性 spike（`dsh-0af20aa2-d0de @ a7009b9`，产物已按用户决定丢弃）评估用已发布的
`command/*` / `tool/*` 核心事件替代 plugin records 派生 mode/watch/reset。结论 **no-go**：6 个实质
反例（handler 在 mutation 后、`command/done` 前读回 projection；命令无结构化 domain outcome；最终
result ≠ mutation commit；create/prompt 自动 watch 与补偿 unwatch 不经过 watch 工具；跨会话
mode-off 无 occupant 自身事件；历史日志无 cutover 边界）详见 [DESIGN](DESIGN.md) §4.4.12。因此
plugin records 的 experimental / 调用方受限依赖**仍然存在**，F 不是可行替代；当前缓解路径仍是
**A 加固**（`record-api.ts` 能力探测 + 显式 memory-only 降级，见上节）与本文[升级门禁](#升级门禁)。
仅当 DSH 提供公开的「mutation 实际提交时点 + 结构化 payload + seq 排序」核心 domain event 时重估。

### 隐私与 canonical 日志导出

这些 plugin records 是 canonical session-log events。rc.1 / rc.5 的
`packages/session-query/session-log-export/src/archive.ts` 将 header 与每个 event 写成 canonical
JSONL 并打入 ZIP；因此 DevLead 的 notification/report 摘要与嵌入的 title 摘要会进入导出归档，
canonical 日志也包含 DSH `session/title` 事件。两个 tag 的
`packages/session/session-log-deepseek/README.md` 与 `src/index.ts` 还确认：该插件由
`packages/bundle/base/cordis.patch.yml:43-44` 默认组合（rc.1 / rc.5 相同）、`enabled` 默认 `true`，
会在符合条件的官方 DeepSeek 模型请求中附加
“every complete canonical event”（raw-number envelope；按连续后缀、2xx 确认、at-least-once）。
这意味着上述 DevLead 内容也可能沿该默认上传路径离开本机。

缓解建议：分享 session-log ZIP 前按敏感归档审查；不需要上传时，在 DSH profile 中将
`session-log-deepseek` 的 `enabled` 设为 `false` 或禁用对应上传插件。这里只披露 DSH 既有行为，
DevLead 不新增上传，也不修改默认配置。

### `Session.snapshotEvents()` 迁移已完成（Batch 1）

rc.1 与 rc.5 的 `packages/core/session/README.md`「Read the log」和
`packages/core/session/src/index.ts` 的 JSDoc 都把 `snapshotEvents()`（连同 `eventAt()` /
`ownEvents()`）标为 deprecated。两个 tag 都没有 sanctioned 的同步原始事件读取替代；官方方向是
Session projection，cold 侧用 `observeSession()` 读取 projection，而不是把同步全日志扫描改成
异步全日志扫描。只读源码核对使用 `git show dsh-v0.2.2-rc.1:<path>` / `rc.5:<path>`，未 checkout
或修改 DSH。

当前生产调用为 **0**（测试 fixture 不计）：

| 原调用 | 当前实现 |
| --- | --- |
| `inbox.ts` 反查 pending message 入队时间 | `devLeadInboxTimes`：只保存当前两个 pending lane 的 id/time，splice 移除即释放 |
| `survivalProof` live/cold answer 证明 | `devLeadChildAnswers`：有界 JSON pending/claimed/candidate/presented/discard；live 用 `ProjectionHandle.stateOf`，cold 用 `observeSession().projections.values` |
| `childLogEvents` | 已删除，不再读取原始事件 |
| `replayChildObserver` | 从同一 child-answer projection 恢复 observer；overflow 按 family 记录，只有缺少其它证据的对应 message survival 返回 unknown，不再全局锁死 repair |
| `question-routing.ts` 人类 turn 判定 | `devLeadTurnSource`，由 DevLeadService 同步读取，pre-tool gate 在不可确认时 fail closed |

cold projection read 有 30 秒超时放弃、每 child single-flight、64 个 raw read 并发上限；超时后
原始 Promise 仍被观察，重试不另起挂起查询。rc.1 没有 `inspectSession()`，因此 child-answer
projection 带 `wire.summary:false` 以同时支持 rc.1 的 `observeSession()` 与 rc.5；它不进入 Session
summary。剩余升级门禁是复核 projection / `observeSession` 契约及 wire 字段，不再允许新增任何
deprecated reader 或其 alias。

## rc.5 web search 变更影响

rc.5 的 `dsh-web` 在未配置 `web.searchProvider` 时按模型路由选择：DeepSeek
`deepseek-official` / `deepseek-account` 走服务端 Messages search，其他路由走
`deepseek-search-api`；`WebSearchRequest` 新增可选 `llmProvider`。这是 `dsh-web` /
`dsh-tool-web` / web-search settings 的内部行为。

本仓库审计结论：

- 仓库代码中 **没有** `webSearch` / `WebSearchRequest` / `deepseek-search-api` /
  `llmProvider` 的引用，也没有 `@deepseek-ai/dsh-web` 或 `dsh-tool-web` 的 import。
- DevLead 的 DSH import 限于 session / agent / command / tool / projection / LLM catalog /
  workspace 等既有服务；dispatch 的模型选择走 `Agent.model.select` 与 `llm.*`，不经过
  web search provider 选择。
- rc.5 上完整 E2E（下）通过，说明工具面、命令、preset roster、watch/notification、单活、
  dispatch 与 report 路径均未受影响。

## 能力矩阵

| 能力 | rc.1 | rc.2 | rc.3 | rc.4 | rc.5 |
| --- | --- | --- | --- | --- | --- |
| 插件加载、16 个主工具 + `devlead_report`、`/devlead`、Web UI | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_list_agent_presets` / 真实 roster | 支持 | 支持 | 支持 | 支持 | 支持 |
| 派发模型选择 + `reasoning_effort` | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_list_models` | 支持 | 支持 | 支持 | 支持 | 支持 |
| Workspace id/注册路径/精确 title 三寻址 | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_prompt_session interrupt`（`workspace/session-stop` providers） | 支持 | 支持 | 支持 | 支持 | 支持 |
| 排队 inbox 输入：`queuedInputs` 明细 / `devlead_retract_input` / `interrupt_inbox` 策略 | 支持 | 支持 | 支持 | 支持 | 支持 |
| watched 子会话问题路由（`tools/pre-execute` + `question` report） | 支持 | 支持 | 支持 | 支持 | 支持 |
| Phase 1d answer routing（`intent`/`question_id`/`idempotency_key` + answer/correction steer + answer record + `delivery`） | 支持 | 支持 | 支持 | 支持 | 支持 |
| Phase 1e message lanes（T2 review steer / P3/P4 action steer / P1/P2 background inject 不唤醒 + notifications/get_session 全量输出 + 指标） | 支持 | 支持 | 支持 | 支持 | 支持 |
| plugin records（`appendPluginRecord` / `PluginRecordMap`；全部 durable 状态） | 存在‡ | 存在‡ | 存在‡ | 存在‡ | 存在‡ |
| 可选 worktree 隔离 | 可选 bundle | 可选 bundle | 可选 bundle | 可选 bundle | 可选 bundle |
| `agent_teams: true` | 不可用\* | 支持† | 支持† | 支持† | 支持† |

\* rc.1 无 `dsh-agent-team`；DevLead 通过 duck-typed `ctx.get('agentTeams')` 探测，不静态 import。
† Host 必须组合 agent-team；默认 `dsh-base` 从 rc.2 起包含。
‡ 实验性、调用方受限；rc.1–rc.5 原文一致，非公开契约，Session format migration best-effort（见上节）。

Workspace 三寻址（`resolveWorkspaceReference`：id → 注册路径 → trim 后大小写敏感的精确 title）
版本无关：rc.1–rc.5 的 WorkspaceRegistry 都允许不同 canonical path 共用 display title，同 title
歧义报 `DEVLEAD_WORKSPACE_AMBIGUOUS` 并列出候选 id/path（见 [DESIGN](DESIGN.md) §4）。

排队 inbox 输入能力依赖的 Host API 在五个 tag 都存在：`Inbox` 契约的按条
`remove(messageId)` / `prepend` / `append` / `clear`（rc.1 `dsh-agent` 声明
`runtime-types.d.ts` 已含全部方法与 `CancelOptions.keepInbox`），消息 id 稳定
（`MessageBase.id`，inbox fold 强制唯一），`agent/inbox/spliced` durable 事件携带入队时间。
`interrupt_inbox` 的保留是快照-停止-恢复（stop provider 固定清队列，无法 veto），不依赖
`keepInbox` 透传；rc.5 驱动循环在每次同步 claim 前检查 abort，恢复的消息不会被垂死 turn
claim。该能力不新增 DSH peer 范围要求。

`devlead_prompt_session interrupt` 复用五个 tag 都存在的 `workspace/session-stop` 事件；
Agent registry 的 turn provider、jobs / subagent / schedule providers，以及 aborted phase 上
把 `followup` 重归类为 `next-turn` 的 wake 逻辑，均在 rc.1–rc.5 的独立 worktree 中核对。
该能力不新增 DSH peer 范围要求。

watched 子会话问题路由依赖五个 tag 都存在的 `tools/pre-execute` waterfall 与稳定的
`ask_user_question` 工具名；legacy / timed 两种 schema 共用该名字。该结论已在 rc.1–rc.5 的
独立 worktree 中核对，未新增 DSH peer 范围要求。

Phase 1d answer routing 依赖的 Host API 在五个 tag 都存在：`Agent.followup` / `steer` / `inject`
（rc.1 `dsh-agent` `runtime-types.d.ts` 已声明；`steer` 对 idle 开 turn、对 running 在下一
pre-step claim，`inject` 不请求 driver wake），`agent/inbox/claimed` / `agent/inbox/discarded`
live 事件与 `user/message` / `turn/end` durable 事件（answer 的 claimed/presented/discarded
内存观测与 turn-end 对账），以及 aborted phase 上把 waking steer 重归类为 `next-turn` 的 send
逻辑（`delivery.boundary` 以实际 inbox 落点为准）。answer record 走既有 `appendPluginRecord` +
`plugin:devlead/*` fold，不新增 DSH peer 范围要求。真实 rc.5 answer E2E（scripted child answer
真实 step + 幂等 + clear-own/clear-all）在 installed/patch 双流通过。

Phase 1e message lanes 复用同一组 Host API，不新增任何 DSH 依赖：T1 仍走 `followup`（400ms
合并），T2/P3/P4/Q1 走 `steer`（next-step、不抢占），P1/P2 走 `inject`（next-step、不请求
driver wake；rc.1 起声明，idle 只 queued 不开 turn）。lane 识别只读消息 source 的
`lane`/`wakeRequested` 字段（runtime 自写，旧消息无 lane 按 legacy turn notice 处理）；
`agent/inbox/spliced` durable 事件用于 e2e 断言实际 admission。notifications/get_session 的
新增输出字段（wakeSuppressedByReportId/wakeSuppressionReason、report lane/deliveryState）与
wire projection 的 questionStatus/answerStatus 都是可选 additive 字段，旧 bundle/旧记录兼容。
指标是进程内低基数 counters，不依赖 Host API。

## 公开但少文档的 core service 假设

以下两条行为在 DSH 包 README / 代码中公开，但没有被承诺为稳定的第三方插件契约；DevLead 把它们
当作已实现的隐式假设，并各自保留 fallback。这里只文档化，不改行为：

1. **`ctx.get('sessionPersistence').list()` 作为 query 语料就绪信号。** 真实 Session query
   engine 通过自己的 scheduled `ctx.inject` 绑定 `sessionPersistence`；在绑定完成前
   `sessionQuery.listSessions()` 可能只返回 live 行。DevLead 在冷重建前比较 persistence
   `list()` 的 stored Session id 集合与 query listing：最多等 2s（100ms 轮询），并且只接受
   包含全部 stored id 的 listing 作为授权证据；屏障返回它校验通过的 listing，权威扫描直接
   消费该 listing（不会在屏障后再 list 一份未校验语料）。屏障超时/持续不一致时**不扫描**
   该 listing 并保持 prompt fail-closed，由后续有界 attempt 或 30s 慢速探针恢复——不再有
   "warning + best-effort 继续扫描"的路径。之后冷扫描按可续扫的多批游标推进，有界窗口按阶段
   独立：扫描阶段（屏障 + listing 校验 + 有界读取）5s，finalize 复核用独立 5s 预算并先停
   attempt deadline，每次 append 批次经 `attempt.extend()` 重新 arm 5s——单次有界 attempt
   理论最坏约 30s（5s + ≤3×5s 复核 + ≤2×5s append 批次），不是"整次 attempt 只有一个 5s"；
   挂起的后端 promise 会被放弃、epoch 作废并计一次失败。每次尝试对有界数量的非 active 候选
   做精确 fold，失败按有界指数退避重试（250ms→5s、最多 12 次），超限后只保留一条 30s 慢速
   降级探针；该 cap 是 sticky 的：探针失败只重排探针，不重启快速退避，且只有完整扫描成功
   finalize、reset 或语料服务重新组合才清除（探针的批次推进不清除）；retry-cap 探针保留游标，
   失败点在第一读批之外时也能从失败点重试。finalize 复核 abort/超时与 **不可验证**（listing/
   真值暂时读不出）都只让本次 attempt 计一次失败并保留 trusted 快照/游标，下一次 attempt 从
   保留游标重做复核，不会永久 fail-closed；只有可读的不一致（`changed`）才丢弃重扫。
   not-found re-list 也必须用 persistence 真值复核：id 真的消失才丢弃快照重扫；id 仍在列时
   是读取失败（保留游标、行内重试一次，连续 not-found 计失败），绝不为仍在列的行重置游标；
   该重试按行记录，不会把后续另一行的首次 not-found 直接算成失败。就绪屏障不可验证同样计
   一次失败，因此间歇性 listing/真值故障会进入 12 次 cap 与 30s 探针，而不是无界快速重扫。
   finalize 要求快照仍是当前语料的 subset；扫描期间新增的持久行在至多 2 次有界刷新里
   append+扫描，刷新预算耗尽而仍有未扫描的新行时不 finalize（fail closed，保留游标）。
   prompt gate 通过后，admission 仍可能 await drain/repair/resume/interrupt，因此 DevLead 在
   resume/interrupt 之前与真正写入 child inbox 之前再次校验 gate 的服务身份 proof；窗口内
   原地 `ctx.set` 替换/移除语料服务会 fail closed 并重扫，不会在旧证明下投递。
   缺少该可选服务时跳过屏障，只有从未证明过持久语料的 Host 才按 live 会话授权。依据：
   `@deepseek-ai/dsh-session-persistence` README（`list()` 返回 one snapshot per visible
   stored session）与 rc.1–rc.5 的 `session-query` optional binding 行为。假设是 `list()`
   完整且 id 与 query listing 可比；DSH 没有把它文档化为“就绪探针”。
2. **`sessionProjectionCache` eager checkpoint。** 全局单活准入与冷重建都用
   `cachedSnapshot(header)` 的 `devLead` 行做零 I/O 预筛，但两者对负判定的用法不同：单活准入
   对 active 行精确 fold、unknown 行有界读取、`enabled:false` 的行直接跳过日志；冷重建只把
   active 行当候选提示，负判定不可信（stale-negative 会让 foreign supervisor 隐身），其余行
   一律按有界 exact-fold 处理。负判定的安全性依赖 DevLead 在 mode/watch/reset 的 durable 写入后
   主动 `await cache.write(session)`，以及 DSH 的缓存契约“the log leads and the cache follows
   ... never ahead of it”。若服务没有 `write` 或写入失败，DevLead warning 后走精确 fold；
   无法分类的行按每次尝试 64 条的全量日志读取上限分批续扫（游标保留，不会因单次上限丢弃剩余行；
   损坏候选推进游标并让索引进入 degraded，由 30s 慢速探针重试）。依据：
   `@deepseek-ai/dsh-session-projection-cache` README 与 `docs/capability-seams.md`
   （`ctx.sessionProjectionCache`）；该 README 只描述 creation / turn-end / disposal 三个
   mandatory write point，没有把 `write()` 单独承诺为第三方插件契约。

**降级终态与恢复路径**：corrupt at-rest replay、live projection failure，以及 12 次有界退避
耗尽（sticky cap），对普通 timer 重试是终态（不热重扫，只保留一条 30s 慢速降级探针）。恢复
路径：(a) 打开（resume）受影响的 DevLead Session 并在其中运行 `/devlead reset`——`/devlead
reset` 要求 live Agent，冷 Session 直接调用会以 `DEVLEAD_AGENT_NOT_LIVE` 拒绝；(b) 删除或
修复损坏/不可读的 Session 日志；(c) 重启 Host 重建索引。30s 慢速探针本身不会修复 at-rest
corrupt / live projection failure：探针每 30s 重试一次，原因未移除时它只会继续失败，只有
原因移除后下一次探针才会恢复。期间 prompt 授权保持 fail-closed（`DEVLEAD_SESSION_UNAVAILABLE`），
错误文案同时给出降级原因与恢复提示。语料服务被替换或卸载同样会作废已证明的索引（包括不换
fiber 的原地 `ctx.set`；绑定 token 取 `impl.value` 的对象身份，真实 `extends Service` 实例也
能检测），重新扫描完成前保持 fail-closed；一旦本进程证明过持久语料，不会退回 live-only 授权。
plugin dispose 会 abort 进行中的 attempt。

## 0.4.0 breaking changes（Batch 1 + Batch 2；由 0.4.0-rc.1 引入）

0.4.0（含其候选 `0.4.0-rc.1`）按「正确性 > 兼容性」执行，以下变更是**有意的**、不提供自动迁移。
Batch 1 实现 breaking 兼容性清理与正确性收口；Batch 2 只把根 `package.json` 与 6 个可发布包
统一 bump 到 `0.4.0-rc.1` 并同步文档/证据/门禁；稳定版 `0.4.0` 只去掉 rc 后缀并同步文档，
**均不改变运行时行为**。Batch 2 门禁的真实输出见
[`docs/e2e-evidence/batch2-release-prep.md`](e2e-evidence/batch2-release-prep.md)，稳定版
`0.4.0` 的最终门禁见
[`docs/e2e-evidence/v0.4.0-release-prep.md`](e2e-evidence/v0.4.0-release-prep.md)。发布说明正文见
[`docs/releases/v0.4.0.md`](releases/v0.4.0.md)（历史候选说明见
[`v0.4.0-rc.1.md`](releases/v0.4.0-rc.1.md)）。

- 7 类 `plugin:devlead/*` record 统一为 `version:2`；v1 record 与缺少必填 `answerSeq` 的旧
  answer 显式忽略并丢弃（每进程一次 warning），**不冻结** projection。旧 Session 的 DevLead
  模式/关注集/digest/answer 状态因此失效，需按下方升级说明处理。
- 当前 `version:2` payload 的字段/类型损坏仍设置 `failure` 冻结 projection，由人类命令
  `/devlead reset` 恢复；坏 reset 不能解冻。projection stateVersion 为 `devLead` **7** /
  `devLeadMode` **3** / `devLeadWatch` **3**，旧缓存行整体失效并从 durable log 重新 fold。
- `devlead_report_outbox` 升级为 `OUTBOX_SPEC` **v3，无 `compatibleVersions`**，pending
  report 的 `origin: 'live' | 'cold'` 必填。旧 v1/v2 outbox、无 origin 的 pending row、旧
  answer-discard 队列数据全部丢弃；旧 domain 无法打开时 warn 并禁用该 durable domain
  （不 crash、不静默写入坏数据）。`answer_discards` 单独保留 **30 天** retention。
- 非 answer 幂等改为 durable：receipt 持久在独立 `devlead_idempotency` **v1** domain 的
  `receipts` 表（**7 天 TTL** + 启动清理），不再承诺重启后 memory window。receipt
  corrupt/unreadable 与 composed storageDomain 打不开时 fail closed；只有 Host 未组合
  storageDomain 时才在进程内兜底，并显式 warning。
- 新增 `DEVLEAD_FOREIGN_SUPERVISOR` / `DEVLEAD_MULTIPLE_SUPERVISORS` 硬拒绝（在任何
  watch/resume/admission 副作用之前）；supervisor 集合不可证明（无 cache、capped unknown、
  stale-negative 或读取失败）时，prompt 以 `DEVLEAD_SESSION_UNAVAILABLE` fail closed。
- `questionTtlMs` 默认 `86400000`（24h），`0` 禁用；只让当前仍 open 的 question lazy 过期，
  answered 不 retroactive 过期，过期 answer 返回 `DEVLEAD_QUESTION_NOT_FOUND`。cold
  open-question replay 每进程最多一次，与普通 action report 共用 16/pair 容量上限。
- correction/background 背压：每个 lead-child pair 的每个 child turn 最多 4 条 correction /
  8 条 background，超出返回 `DEVLEAD_DELIVERY_RATE_LIMITED`。
- `DevLeadProjectionReport.repairPending` 是 runtime 可选投影字段（whole-value
  `plugin:devlead/repair` 记录驱动，mark/clear 双向发布）；它不替代 answer 的 durable 完成证据。
- 生产代码中 deprecated 的 `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 调用为
  **0**（测试 fixture 不计）：inbox 入队时间、turn source 与 child answer survival 改由有界
  projection 承载，cold 侧只读 `observeSession()` projection（取代原同步全日志扫描，见上节）。
- 配置新增 `questionTtlMs`（默认 86400000，0 禁用）与 `actionRequiredBatchMs`（0–400ms，
  默认 0）；UI 新增三 lane header / lane 着色 / question 状态与 `provisional` 标记。
- **旧 DevLead Session state 有意不迁移**：升级后受影响的 Session 需要人类命令
  `/devlead reset`（或 `/devlead off`，它可重置冻结折叠）恢复；reset 是唯一在冻结检查之前
  应用的 record。冷 Session 先 resume/open 再 reset。
- **回滚同样隐含 reset**：回滚到 `0.3.0-rc.2` 或更旧版本后，旧 fold 对已知类型的 v2 payload
  会 freeze，因此降级也需要 `/devlead reset`；不能宣称“回滚不会因新记录损坏日志”。

## 升级门禁

升级 DSH（任一新 rc 或进入 0.3.0）前必须全部通过：

1. `pnpm verify` 与 `pnpm check:packages`（类型检查仍按最旧 rc.1 devDeps）；必须包含
   `packages/devlead/tests/record-api.spec.ts` 的正常路径 negative control，以及 writer-only /
   reader-only 缺失、首读/首写与 reader 晚失败、warn-once、失败 append=false、fold 不冻结、
   Service 可加载的降级用例。
2. 核对实验性扩展点的**声明与语义**，不能只检查名字：`appendPluginRecord` /
   `pluginRecordOf` / `PluginRecordMap` 仍存在，同步签名与 `PluginRecord` envelope（`type` /
   `seq` / `time` / `data`）未变；写入仍是 `ignorable:true`、JSON snapshot 后同步 commit，
   `pluginRecordOf` 仍只提取 record 而由 owner 严格校验 payload。`packages/core/session/README.md`
   的调用方限制与 Session format migration best-effort 条款也必须重新核对。
3. 核对生产代码仍无 `Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 或其 alias；
   `devLeadInboxTimes` / `devLeadTurnSource` / `devLeadChildAnswers` projection 与 cold
   `observeSession()` wire 契约仍存在。deprecated reader 被移除不应影响本仓库；projection/query
   语义变化必须先修复并重新跑 cold-discard / hung-read 测试。
4. 在 **rc.1 到目标版本的每个 rc** 跑兼容矩阵；不能只测最新版本。每个版本至少重跑
   [真实 E2E](#真实-e2e) 的 installed + patch `--no-worktree`，声明 worktree / Team 能力时跑
   完整组合；另跑 record facade 的正常/降级测试，验证实际加载的导出与首写/首读路径。临时安装、
   目标 typings 编译、三条命令与证据留存按下方[可执行 recipe](#逐-rc-可执行-recipe) 执行。
5. 对旧日志做 record schema / migration 核对：七类 `plugin:devlead/*` 的 `kind` / `version` /
   字段集、reset 解冻规则、strict decoder 与 projection stateVersion 必须一致。`0.4.0` 的
   既定策略是 v1 record、无 `answerSeq` 的 answer 与 v1/v2 outbox **显式丢弃**，不要误判为当前
   schema 损坏而冻结；当前 v2 损坏仍按**可能不可恢复**处理：先备份原始日志、冻结并提供
   `/devlead reset`，不得把读取失败当作空日志，也不得用静默 reset 丢弃当前状态。
6. 核对能力矩阵依赖的 Host API（Team / worktree / inbox / stop / question routing）与
   projection / summary 契约仍存在。
7. 发布前的完整重跑与三门真实 E2E 仍按 [PUBLISHING](PUBLISHING.md)；证据日志必须来自冻结的
   最终树并保留真实退出码。

升级到 `0.4.0`（插件升级，不是 DSH 升级；从 `0.4.0-rc.1` 升级同样适用）后还需要同时注意：

- **旧 devlead state 被显式丢弃、不迁移**：受影响的 Session 打开后运行人类命令
  `/devlead reset`（`/devlead off` 也可重置冻结折叠；冷 Session 先 resume/open），之后重新
  `/devlead on` 并按需重建关注集。不要把它当数据丢失 bug 处理。
- **新配置**：`questionTtlMs`（默认 `86400000`，`0` 禁用）与 `actionRequiredBatchMs`
  （0–400ms，默认 0）通过 loader row `devlead` 的 `config` 覆盖，不要用 deployment 默认值
  推断运行行为。
- **multi-lead 仍是 Host 级硬门禁**：已有一个 active lead 时，第二个 lead 必须先
  `/devlead off`；否则 prompt 会以 `DEVLEAD_MULTIPLE_SUPERVISORS` /
  `DEVLEAD_SESSION_UNAVAILABLE` fail closed。
- **projection cache 自愈**：stateVersion 小于 7 的 projection cache 行整体失效，从 durable log
  重新 fold（stateVersion 7/3/3），不需要手工删除缓存。

任一项失败或上游 API 语义变化时，不得宣称兼容；应修复、显式降级并在本页记录（README 只保留
面向使用者的升级提示）。

### 逐 rc 可执行 recipe

对 rc.1 到目标版本的每个 `RC` 分别执行。源码与依赖都在临时目录，main 的 lockfile、真实
profile 和 DSH clone 不变；`git archive HEAD` 要求先固定待验证提交：

```sh
set -euo pipefail
export RC=0.2.2-rc.5
REPO=$PWD
ROOT="$HOME/Library/Caches/dsh-plugin-tests/dsh-devlead"
mkdir -p "$ROOT"
WORK=$(mktemp -d "$ROOT/gate-$RC.XXXXXX")
SRC="$WORK/src"
BASE="$WORK/dsh"
EVIDENCE="$WORK/evidence"
mkdir -p "$SRC" "$BASE/tmp" "$BASE/install" "$EVIDENCE"
git archive HEAD | tar -x -C "$SRC"

# 只在临时源码树把全部 DSH devDependencies 固定到目标 rc，并编译其 typings。
node - "$SRC/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const [name, _range] of Object.entries(manifest.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = process.env.RC
}
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
NODE
pnpm -C "$SRC" install

run_gate() {
  local name=$1
  shift
  set +e
  "$@" >"$EVIDENCE/upgrade-$RC-$name.log" 2>&1
  local code=$?
  set -e
  printf '%s_EXIT=%s\n' "${name//-/_}" "$code" >>"$EVIDENCE/upgrade-$RC-$name.log"
  return "$code"
}
run_gate typings pnpm -C "$SRC" typecheck
run_gate build pnpm -C "$SRC" build

# 每个 rc 使用独立的临时 CLI 与 scratch DSH_HOME。
npm install --prefix "$BASE/install" --cache "$BASE/npm-cache" "@deepseek-ai/dsh@$RC"
DSH_BIN="$BASE/install/node_modules/@deepseek-ai/dsh/lib/bin.js"
cd "$SRC"
run_gate dsh-version env TMPDIR="$BASE/tmp" "$DSH_BIN" --version
run_gate patch env TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" \
  node scripts/e2e-smoke.mjs --flow patch --no-build --root "$BASE/tmp/e2e-patch"
run_gate installed env TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" \
  node scripts/e2e-smoke.mjs --flow installed --no-build --root "$BASE/tmp/e2e-installed"
run_gate no-worktree env TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" \
  node scripts/e2e-smoke.mjs --no-worktree --no-build --root "$BASE/tmp/e2e-no-worktree"

cp "$EVIDENCE"/*.log "$REPO/docs/e2e-evidence/"
git -C "$REPO" add -f \
  "docs/e2e-evidence/upgrade-$RC-typings.log" \
  "docs/e2e-evidence/upgrade-$RC-build.log" \
  "docs/e2e-evidence/upgrade-$RC-dsh-version.log" \
  "docs/e2e-evidence/upgrade-$RC-patch.log" \
  "docs/e2e-evidence/upgrade-$RC-installed.log" \
  "docs/e2e-evidence/upgrade-$RC-no-worktree.log"
```

当前 harness 的 pin 来自 `scripts/e2e-smoke.mjs` 的 `EXPECTED_CHECKS`
（phase 1=30、1b=18、2=24、3=135、1e=31）：patch / installed 完整流必须各为 **238/238**，
no-worktree 必须为 **214/214**（仅跳过 phase 2）；完整流目标计数为 **235 PASS + 3** 条有真实
原因的正向模型选择 SKIP，其他检查不得通过删除或放宽断言来凑数。未来 pin 变化只能先更新
`EXPECTED_CHECKS` 并在证据中解释。

每个 rc 的 typings/build/三条 E2E 日志都必须复制到 `docs/e2e-evidence/`，保留真实 `*_EXIT=`
行、`DSH_BIN --version` 输出与总计行；`*.log` 被 ignore 时用 `git add -f` 显式纳入证据 commit。
临时目录默认清理，失败时先保留以便复现；不得在真实 profile 上执行该 recipe。

## 真实 E2E

所有命令使用 npm 临时安装的 DSH CLI（`DSH_BIN`），独立 `DSH_HOME`，不修改桌面 profile。
rc.5 的临时目录固定在磁盘缓存（不是默认 `/tmp`）：

```sh
BASE="$HOME/Library/Caches/dsh-plugin-tests/dsh-devlead/rc5"
DSH_BIN="$BASE/install/node_modules/@deepseek-ai/dsh/lib/bin.js"

TMPDIR="$BASE/tmp" "$DSH_BIN" --version
# 0.2.2-rc.5

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow installed --no-worktree --no-build --root "$BASE/tmp/e2e-no-worktree"

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow installed --no-build --root "$BASE/tmp/e2e-installed"

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow patch --no-build --root "$BASE/tmp/e2e-patch"
```

| DSH | flow | 结果 |
| --- | --- | --- |
| `0.2.2-rc.1` | installed `--no-worktree` | **120/120**（Team 不可用分支） |
| `0.2.2-rc.2` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.3` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.4` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.4` | installed / patch 完整 | **143/143** 各（phase 2 23/23） |
| `0.2.2-rc.5` | installed `--no-worktree` | **123/123**（phase 1 27 + 1b 12 + 3 84，含问题路由 gate） |
| `0.2.2-rc.5` | installed 完整（0.2.6+ 审计轮重跑） | **146/146**（phase 1 27 + 1b 12 + 2 23 + 3 84，含 question gate） |
| `0.2.2-rc.5` | patch 完整（0.2.6+ 审计轮重跑） | **146/146**（同上） |
| `0.2.2-rc.5` | installed 完整（排队输入轮重跑） | **150/150**（phase 3 88，另含 4 条排队 inbox checks） |
| `0.2.2-rc.5` | patch 完整（排队输入轮重跑） | **150/150**（同上） |
| `0.2.2-rc.5` | installed `--no-worktree`（排队输入轮重跑） | **127/127**（phase 1 27 + 1b 12 + 3 88） |
| `0.2.2-rc.5` | installed / patch 完整（Phase 1c 证据轮，pin 总数） | **174/174** 各（171 PASS + 3 SKIP；真实 scripted child turn） |
| `0.2.2-rc.5` | installed / patch 完整（Phase 1d answer routing，pin 总数） | **188/188** 各（185 PASS + 3 SKIP；phase 3 126，含真实 answer steer + 幂等 + clear-own/clear-all） |
| `0.2.2-rc.5` | installed / patch 完整（Phase 1e message lanes，pin 总数） | **221/221** 各（218 PASS + 3 SKIP；phase 3 128 + phase 1e 31：background 不唤醒、action/review steer、T1/T2 分流、合并抑制、显式 16-pending action 上限、低基数指标） |

rc.1–rc.4 的行是各自发布时的 harness 计数；0.3.0 的 prerelease 候选（0.3.0-rc.1 / rc.2；稳定版
0.3.0 未发布，规划内容合入 0.4.0）含 question 路由与排队 inbox 输入，这些 checks 已并入当前
harness 的 phase 3 / 1e。0.2.6+ 审计轮（[AUDIT](AUDIT.md) §12）已按当前 harness 重跑 rc.5
`--no-worktree`（123/123）与 installed/patch 完整（各 146/146，安装版 rc.5）；排队输入轮再增
4 条 inbox checks 后重跑 rc.5 installed/patch 完整（各 **150/150**）与 `--no-worktree`（**127/127**）；
Phase 1c 证据轮（真实 scripted child turn）pin 总数 **174/174**；Phase 1d answer routing 轮再增
14 条 answer checks（真实 answer steer + 幂等 + clear-own/clear-all）后 installed/patch 双流各
**188/188**（phase 3 126）；Phase 1e message-lane 轮把 progress check 改写为 2 条 background
lane pins（phase 3 128）并新增独立 phase 1e 实例（31 条：background 不唤醒 + 读工具
lane/deliveryState、blocked/decision action steer、真实 T1 followup / T2 review steer、合并抑制
字段、17 接受/第 18 条显式 `DEVLEAD_DELIVERY_RATE_LIMITED`、指标低基数）。

上表 Phase 1e 行即 **Batch 1 最终树**的 pin 实测：installed / patch 完整流各 **221/221**
（218 PASS + 3 SKIP；phase 1 27 + 1b 12 + 2 23 + 3 128 + 1e 31），`--no-worktree` **198/198**
（phase 2 skipped）。当前候选发布版本是插件 **`0.4.2-rc.2`**（prerelease，dist-tag `next`；
approve 前 `next` 仍为 `0.4.0-rc.1`，`latest` 为 `0.4.1`；DSH 兼容面仍为 rc.1–rc.5）。
`0.4.0-rc.1` 候选的三条真实
E2E 重跑（含真实 `*_EXIT=0` 与总计行）记录在
[`docs/e2e-evidence/batch2-release-prep.md`](e2e-evidence/batch2-release-prep.md)；稳定版 `0.4.0`
在最终 release 树上的三条真实 E2E 重跑记录在
[`docs/e2e-evidence/v0.4.0-release-prep.md`](e2e-evidence/v0.4.0-release-prep.md)。发布前仍需按
[PUBLISHING](PUBLISHING.md) 在冻结树重跑完整组合。

当前 board 加固轮保留上述全部旧检查，并在 phase 3 新增真实 `ctx.devLead.updateBoard` 写入/CAS、
`webserver/index-inject` board global 与独立磁盘 revision/内容 read-back；Step B 复核修复轮又把
phase 1 与 1b 改回未配置 `boardPath` 的默认组合并固定当轮目标 pin（phase 1=28、phase 3=132、
完整流=226、no-worktree=203）。**本轮的权威 pin 是 `scripts/e2e-smoke.mjs` 的
`EXPECTED_CHECKS`：phase 1=30、phase 1b=18、phase 2=24、phase 3=135、phase 1e=31，完整流
238/238（235 PASS + 3 credential-less SKIP），`--no-worktree` 214/214。** 本轮新增/改写的断言
包括：没有 lead 时不注入 board global、lead 开启后从 `SessionHeader.cwd` 派生默认路径并发布
`{leadSessionId, override:false}`、预创建父目录、冷 lead 从持久 header 派生、`/devlead off`
移除 global、换 workspace 后立即换源、phase 2 的 Config override 以 `override:true` 发布、
phase 3 的 lead-off store 释放（没有 workspace 根的 `BOARD_DISABLED` 由 host 单测覆盖，e2e 的 HTTP session/create 总会落一个 cwd）。真实 PASS 日志与证据由 Lead
记录在 `docs/e2e-evidence/`；上表 Phase 1e 行（221/198、218 PASS）与上一轮 226/203 均为历史
实测，不改写为新一轮证据。

**0.4.2-rc.1 收口轮**（自 0.4.1 起的看板 follow-up）不改 DSH 兼容面：看板默认启用、路径跟随
active lead workspace、lead-only 浏览器入口、工具 64 KiB 读取上限与长 path/title 引用修复来自
`0.4.1..f69bd21` 的 5 个 commit；本轮再补 P2/P3 收口（冷 workspace 缺失不重建、
`boardDisabledReason`、same-path start 重试、restored board tab 首轮关闭、64 KiB 文案与
client-ui/package 拓扑文档修正），全部使用 0.2.2-rc.1 typings 与 rc.5 安装版共有的 API，
engines/peer range 不变。

**0.4.2-rc.2 发布轮**（相对 rc.1 只有测试确定性修复）不改 DSH 兼容面、不改产品代码：
`board-io.spec.ts` 的 read-failure 用例改为在从未 `start()` 的新 store 上命中注入的
`stat`/`readFile` 错误，不再依赖 watcher/缓存的并发 reload 时机；`board.spec.ts` 的只读父目录
writer-lock 用例改为在 `withFileLock` seam 注入 errno，不再依赖 `chmod`/非 root uid。功能内容
仍是上一段 rc.1 收口轮的内容。

每条 flow 有 3 条正向模型选择检查因无 provider 凭据 SKIP（打印真实原因）；负向
`DEVLEAD_MODEL_UNAVAILABLE`、`devlead_list_models`、preset roster 与 watched-child
`devlead_report` 均真实运行。

## UI 面

- rc.5 的 `@deepseek-ai/dsh-client-ui-workspace` 仍提供
  `sidebar.session.row.leading` / `.trailing` / `.hover`，Session 行仍带
  `data-row-key="session:<id>"`，行 CSS 仍使用 `border-inline: var(--dsh-sidebar-paint-inset)
  solid transparent`。现有 active overlay ring / watched mark 的 DOM 依赖未变化。
- E2E boot graph 确认 rc.5 加载 `@yankeguo/dsh-client-ui-devlead/client.js`；lead 的
  `devLead` / `devLeadMode` / `devLeadWatch` projection 均存在，summary 携带
  `devLeadMode` 与 `devLeadWatch`，且不携带 digest。DevLeadBar 读取的 `devLead` projection
  含 enabled / sessions / notifications / reports；组件级渲染断言由 `pnpm test` 覆盖。
- 项目看板右栏的 definition id/kind 分工、keyed body、header utilities、Workspace Files unary/stream
  类型与 Workspace/Session hooks 已逐行核对 rc.5 tag；这些 API 在 rc.1 npm typings 同样存在并通过
  全仓 typecheck。`dsh.client.inject` 是**静态**包声明，共 11 项（含 `dsh-api-workspace-files`、
  `dsh-api-workspace-controller`、`dsh-client-ui-sidebar-right`），不由看板开关或 lead 状态增删；
  浏览器侧静态组合 `remote.workspaceFiles` / `sidebarRight` / `sidebarRightTabs` / `workspaces`。
  看板入口是 **lead-only** 的：tab/guide/header 按钮只在屏幕上的 active lead Session 注册/渲染，
  非 lead 与 subagent Session 没有入口；Host 只在当前 active lead 拥有看板路径时注入
  `__DSH_DEVLEAD_BOARD__`，没有 lead 时该 global 缺失。页面在 lead 启用之前加载时，client 从
  该 lead Session summary 的 `cwd` 派生默认路径；使用 Config `boardPath` override 的部署在
  late-enable 场景需要刷新页面（只有新 HTML 携带 override 路径与 `override:true`）。模式 off、
  Session 切换、路径切换会立即 dispose 旧面板并重读新文件。
- rc.5 Web UI 的视觉行为本轮没有截图工具证据；自动化侧的判定依据是 slot/DOM 源码未变、boot
  graph 加载成功、projection 数据与渲染测试通过。视觉部分（composer 开关、DevLeadBar、lane
  着色、question 状态、`provisional` 标记、侧栏 active ring / watched 准星，以及看板 lead-only
  入口、默认派生路径与面板状态）按 [UI-VERIFICATION](UI-VERIFICATION.md) 在隔离 profile 里做
  **人工验收**，以该 checklist 的记录为准。此项是发布前的人工验收项，不由 e2e 或渲染断言替代，
  也不以本轮的无截图状态视为已通过。

## 维护注意

- 每次 DSH 升级先走「升级门禁」，再跑本页命令；plugin records 与 `Session.snapshotEvents()`
  是两条明确的非稳定依赖，不要把它们当作已发布契约。
- 每次 DSH rc 升级先跑本页命令；如果 rc.5+ 改动 `data-row-key`、slot id 或
  `--dsh-sidebar-paint-inset`，需同步 client-ui 的 CSS 与 i18n 测试。
- 不要为了 rc.5 把 `engines.dsh` 缩窄到 `>=0.2.2-rc.5`；目标仍是 rc.1–rc.5。
- 临时目录统一放在 `~/Library/Caches/dsh-plugin-tests/dsh-devlead/<rc>`，并设置
  `TMPDIR`、`--root` 与 npm cache；测试结束删除安装/缓存，只保留日志。
