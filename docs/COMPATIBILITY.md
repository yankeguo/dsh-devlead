# DSH 兼容性矩阵

本仓库的目标兼容面是 **DeepSeek Harness `0.2.2-rc.1` – `0.2.2-rc.5`**。6 个可发布包的
`engines.dsh` 均为 `>=0.2.2-rc.1 <0.3.0`（根 `package.json` 是 private 包，不声明
`engines.dsh`，只声明 `engines.node`），所有
`@deepseek-ai/dsh-*` peer 使用同一范围；本地 devDependencies 仍固定 rc.1，用最旧 API 做
类型检查。

## 契约

- DSH loader 只按 `engines.dsh` 判定插件兼容性；peer 范围供 profile 的 pnpm 检查使用。
- `0.2.2-rc.5` 落在现有 semver 范围内，**无需改 `engines.dsh` 或 peer 范围**。
- 各 rc 的能力差异：
  - `agent_teams` 从 rc.2 起可用；rc.1 返回 `DEVLEAD_TEAM_UNAVAILABLE`，不创建 Session。
  - 可选 worktree 隔离需要 Host 组合实验性 worktree/forge 服务；rc.4 / rc.5 的完整 E2E
    覆盖 phase 2。
  - 与 DevLead 相关的 rc.4 差异是 DeepSeek 流式拒答的 LLM 错误码；DevLead 不分类该错误码。
  - rc.5 只改 web search provider 选择（见下）；DevLead 不读取或调用该 API。
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
| 插件加载、14 个主工具 + `devlead_report`、`/devlead`、Web UI | 支持 | 支持 | 支持 | 支持 | 支持 |
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
   `list()` 的 stored Session id 集合与 query listing：最多等 2s（100ms 轮询），并且只把就绪后
   取得的 listing 当作可 finalize 的可信快照（就绪前取得的 listing 会在就绪后重新列出）；之后
   冷扫描按可续扫的多批游标推进，每次尝试对有界数量的非 active 候选做精确 fold，失败按有界
   指数退避重试（250ms→5s、最多 12 次），超限后只保留一条 30s 慢速降级探针。超时只 warning
   并 best-effort 继续，缺少该可选服务时跳过屏障。依据：
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
耗尽，对普通 timer 重试是终态（不热重扫，只保留一条 30s 慢速降级探针）。恢复路径：
(a) 在受影响的 DevLead Session 运行 `/devlead reset`；(b) 删除或修复损坏/不可读的 Session；
(c) 等待 30s 慢速降级探针，或重启 Host。期间 prompt 授权保持 fail-closed
（`DEVLEAD_SESSION_UNAVAILABLE`），错误文案同时给出降级原因与恢复提示。

## 0.4.0 Batch 1 breaking changes

- 当前 record `version:2`；v1 与无 `answerSeq` 的旧 answer 忽略并一次性 warning，旧 Session 的
  DevLead 状态失效，不冻结；当前版本损坏仍冻结并可 `/devlead reset`。stateVersion 为 7/3/3。
- `OUTBOX_SPEC` v3 无 `compatibleVersions`，`origin` 必填。旧 v1/v2 outbox、无 origin pending row、
  旧 answer-discard 队列数据全部丢弃；旧 domain 无法打开时 warn + 禁用 durable domain，不 crash、
  不静默写坏。`answer_discards` 30 天 retention 保留。
- 非 answer 幂等改用独立 `devlead_idempotency` v1 domain，7 天 TTL；不再承诺重启后 memory window。
  composed storageDomain 打不开或 receipt corrupt/unreadable 时 fail closed；只有 Host 未组合
  storageDomain 时才在进程内兜底并显式 warning。
- 新增 `DEVLEAD_FOREIGN_SUPERVISOR` / `DEVLEAD_MULTIPLE_SUPERVISORS` 硬拒绝；无 cache、capped
  unknown、stale-negative 或读取失败使 supervisor 集合不可证明时，prompt 以
  `DEVLEAD_SESSION_UNAVAILABLE` fail closed。`questionTtlMs`
  （默认 24h，0 禁用）、cold open-question replay（每进程一次）、correction/background 每
  child-turn 4/8 上限。`DevLeadProjectionReport.repairPending` 是 runtime 可选投影字段。

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
   字段集、reset 解冻规则、strict decoder 与 projection stateVersion 必须一致。0.4.0 的既定策略是
   v1 record、无 seq answer 与 v1/v2 outbox **显式丢弃**，不要误判为当前 schema 损坏而冻结；
   当前 v2 损坏仍按**可能不可恢复**处理：先备份原始日志、冻结并提供 `/devlead reset`，不得把
   读取失败当作空日志，也不得用静默 reset 丢弃当前状态。
6. 核对能力矩阵依赖的 Host API（Team / worktree / inbox / stop / question routing）与
   projection / summary 契约仍存在。
7. 发布前的完整重跑与三门真实 E2E 仍按 [PUBLISHING](PUBLISHING.md)；证据日志必须来自冻结的
   最终树并保留真实退出码。

任一项失败或上游 API 语义变化时，不得宣称兼容；应修复、显式降级并在本页与 README 记录。

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
（phase 1=27、1b=12、2=23、3=128、1e=31）：patch / installed 完整流必须各为 **221/221**，
no-worktree 必须为 **198/198**（仅跳过 phase 2）；正向模型选择仍允许既有的 3 条有真实原因的
SKIP，其他检查不得通过删除或放宽断言来凑数。未来 pin 变化只能先更新 `EXPECTED_CHECKS` 并在
证据中解释。

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

rc.1–rc.4 的行是各自发布时的 harness 计数；0.3.0 的 prerelease 候选（0.3.0-rc.1 / rc.2，尚未 promote
为稳定版）含 question 路由与排队 inbox 输入，当前 harness 的 phase 3 含这些 checks。0.2.6+ 审计轮（[AUDIT](AUDIT.md) §12）已按当前 harness 重跑 rc.5
`--no-worktree`（123/123）与 installed/patch 完整（各 146/146，安装版 rc.5）；排队输入轮再增
4 条 inbox checks 后重跑 rc.5 installed/patch 完整（各 **150/150**）与 `--no-worktree`（**127/127**）；
Phase 1c 证据轮（真实 scripted child turn）pin 总数 **174/174**；Phase 1d answer routing 轮再增
14 条 answer checks（真实 answer steer + 幂等 + clear-own/clear-all）后 installed/patch 双流各
**188/188**（phase 3 126）；Phase 1e message-lane 轮把 progress check 改写为 2 条 background
lane pins（phase 3 128）并新增独立 phase 1e 实例（31 条：background 不唤醒 + 读工具
lane/deliveryState、blocked/decision action steer、真实 T1 followup / T2 review steer、合并抑制
字段、17 接受/第 18 条显式 `DEVLEAD_DELIVERY_RATE_LIMITED`、指标低基数），installed/patch 双流各
**221/221**（`--no-worktree` **198/198**）。发布前需按 [PUBLISHING](PUBLISHING.md) 重跑完整组合。

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
- rc.5 Web UI 的视觉行为未在本轮用截图工具重跑（浏览器扩展不可用）；判定依据是
  slot/DOM 源码未变、boot graph 加载成功、projection 数据与渲染测试通过。此项不替代完整
  人工视觉验收。

## 维护注意

- 每次 DSH 升级先走「升级门禁」，再跑本页命令；plugin records 与 `Session.snapshotEvents()`
  是两条明确的非稳定依赖，不要把它们当作已发布契约。
- 每次 DSH rc 升级先跑本页命令；如果 rc.5+ 改动 `data-row-key`、slot id 或
  `--dsh-sidebar-paint-inset`，需同步 client-ui 的 CSS 与 i18n 测试。
- 不要为了 rc.5 把 `engines.dsh` 缩窄到 `>=0.2.2-rc.5`；目标仍是 rc.1–rc.5。
- 临时目录统一放在 `~/Library/Caches/dsh-plugin-tests/dsh-devlead/<rc>`，并设置
  `TMPDIR`、`--root` 与 npm cache；测试结束删除安装/缓存，只保留日志。
