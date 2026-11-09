# 审计记录：DevLead 套件对 DSH 0.2.2-rc.1 的全面核验与修复

本文件记录一轮对整套插件的**全量审计、优化与打磨**：审计基准是官方 DeepSeek Harness
`0.2.2-rc.1` 源码（`/Users/guoyk/Workspace/src/deepseek-harness`，与本套件安装的
`@deepseek-ai/*` 同一版本）以及已安装包的声明；第三方插件（包括早期参考过的
`dsh-infini-goal`）只作为线索，不作为依据。审计覆盖 6 个包与全部脚本/CI/文档，逐项核验
DSH API 语义、错误路径、并发与生命周期、性能、打包与安装路径，并补齐回归测试与本机真实
DSH 端到端验证。

> **快照说明**：本文件是**上一轮**全量审计的历史记录，其中的测试/ E2E 计数（399 tests、
> 25/25 checks）记录的是当时的工作树。当前工作树新增了可选 worktree 隔离与依赖姿态审计，
> 最新验证数字与结论见 [`DESIGN.md`](DESIGN.md) §12 与
> [`OPTIONAL-DEPENDENCIES.md`](OPTIONAL-DEPENDENCIES.md)（当前：21 文件 / 467 tests、
> e2e patch / installed 各 33/33）。

## 1. 结论摘要

- **发现并修复 1 个高严重度集成缺陷**：`pnpm dev:patch` + `dsh --patch` 的开发/E2E 路径会
  在 Host 进程里产生第二份 DSH 运行时，导致 `/devlead on` 这类第一次写 Session 插件记录的
  操作直接失败（`gateway/internal: Receiver must be an instance of class Session`）。
- 另修复若干中低严重度正确性问题：列表/身份解析被 `maxListedSessions` 错误截断、
  `options.signal` 被静默忽略、Workspace 注册错误码误分类、`flush()` 语义误判、
  严格解码缺口、零延迟通知泵的代际竞态、命令解析与附件契约、客户端准入静默成功、
  CSS/可访问性缺陷、若干打包与脚本缺陷（详见下文）。
- 性能：列表路径改为「便宜事实 → 排序截断 → 组装视图」；`workspaceRegistry` 从每行一次
  反查改为每次一次；精确 id 解析不再列出持久化语料。测试用 fake 计数器固定了这些行为
  （7 行 / limit 2 的列表：`turnBoundaryOf` 折叠 7→2 次，registry 列表 8→2 次）。
- 验证：`pnpm verify`（typecheck + **399** 个测试 / 17 文件 + 7 个构建产物）通过；
  `pnpm check:packages` 通过；`pnpm e2e` 的 `patch` 与 `installed` 两条加载流都在真实
  DSH Web 上 **25/25** 检查通过。

## 2. 高严重度：开发 overlay 的跨运行时副本

**症状**：按 README 旧文档执行 `pnpm build && pnpm dev:patch` 后用
`dsh web --patch .tmp/cordis.patch.yml` 启动，`/devlead` 状态可读、投影可读，但
`/devlead on` 返回 `gateway/internal: Receiver must be an instance of class Session`。

**根因**：`--patch` 用**绝对路径**插入插件入口，插件里 external 的 `@deepseek-ai/*` 会从
本仓库的 pnpm `node_modules` 解析，于是进程里出现第二份 DSH 运行时。读路径（投影、命令
注册）按名字跨 Cordis 服务工作，看不出问题；第一次跨副本私有类检查
（`appendPluginRecord` → `Session#appendRecord`）就炸。

**官方机制**：DSH `app-boot` 的 profile resolution 把「active profile 的 `node_modules` 下
指向 profiles 树之外的符号链接」视为 **linked root**；链接目标下的导入方在每层
`node_modules` 位置按 `peerDependencies` 把名字解析到安装实例
（`packages/boot/app-boot/src/profile-resolution/resolver.ts` `routeLinked()` 与
`packages/boot/app-boot/README.md` 的 linked directories 规则）。本套件各包已把
`@deepseek-ai/*` 运行期导入声明为 peers，所以一个链接即可单实例化。

**修复**：`scripts/dev-patch.mjs` 现在（1）校验目标 profile 存在、未启用本 bundle；
（2）生成绝对路径 overlay；（3）幂等写入
`<profile>/node_modules/devlead-repo -> 本仓库`（refuse 非符号链接冲突）；（4）打印完整启动
命令。`--no-link` 仅供检查、不能用于真实启动。`install-profile.mjs` 的包符号链接本来就是
linked roots，因此安装路径不受影响。

**证据**：修复前在隔离 `DSH_HOME` + 真实 `dsh` 上复现 `/devlead on` 失败；修复后同一流程
`pnpm e2e` 25/25，且 `install-profile` 流同样 25/25。该缺陷已固化为 `pnpm e2e` 的默认
patch 流检查（`scripts/e2e-smoke.mjs` 会断言 linked root 存在）。

## 3. 核心包（`packages/devlead`）

- **列表与身份解析**：`listSessions` 改为 `(agent, options)`（`options.signal` 真正传入
  `sessionQuery` 读取，取消不再被静默降级）；持久化语料窗口只约束列表，**身份解析改为穷尽**
  并加精确 id 快路径（watch 集合 → live Session/Agent → 单 id `readTitleSnapshot`），列表
  窗口外的完整 id / 唯一前缀重新可寻址（修复了 README/DESIGN 承诺与实现不一致）。
  `watchedOnly` 列表不会截断到小于 watch 集合；`limit` 必须是正安全整数并 cap 在
  `maxListedSessions`。
- **Workspace**：`useWorkspace` 不再重复 registry 已做的校验；错误分类改为
  「目录缺失（且未允许创建 / 创建失败）→ `DEVLEAD_DIRECTORY_MISSING`；相对路径 / 文件 /
  不可用父目录 / registry 失败 → `DEVLEAD_INVALID_INPUT`」；`title` 明确只作用于新记录。
  lead cwd 的隐式注册失败也不再泄漏原始 `fs` 错误。
- **写入**：`createSession` 先做 watch 容量预检（不再先建 Session 再报超限）；
  `promptSession` 在归档/无 activator 预检之后才 apply 自动 watch（不再半应用 watch）；
  三个写方法新增协作式 `signal`（阶段边界检查，取消按标准 `AbortError` 拒绝）。
  `ctx.sessions.flush() === false` 按官方语义（没有持久化参与者）静默处理，参与者异常只
  warning，不会让已提交的内存 append 变成抛错。
- **严格解码**：mode/watch/notification 记录与通知值改为**精确字段集**解码（多余/缺失字段、
  重复 watch id、非正 turn、超出 `Date` 可表示范围的时间戳全部拒绝 replay，
  `failure` 保留最后有效状态）；写侧也做可表示性守卫，不写自己 fold 会拒绝的记录。
- **Projection 契约**：无关事件保持同一 state 引用；watch 整值记录与当前集合相同则复用引用；
  只有 host-only `failure` 变化时复用上个 wire view，抑制无意义推送；unit 声明
  `wire.summary: false` 且 protocol 侧标记 `SessionProjectionSummaryExcluded`，保留的通知
  摘要不再进入每个 Session 的 summary/list payload。
- **通知泵**：修复 `notificationBatchMs: 0` 下模式关闭 / Agent dispose 后微任务仍可唤醒的
  代际竞态；投递失败改为**有界 1s 重试**（原实现可能按合并窗口空转或丢批）；同一确定性 id
  在一次 digest 中只唤醒一次（持久记录仍完整）；归档 lead 暂停投递并保留持久记录；
  损坏 lead replay 每个 Session 只 warning 一次；`start()` 幂等、dispose 清理 timer/index；
  240 字符 assistant 摘要规则收敛到单一 helper。
- **其它**：`DEVLEAD_AGENT_NOT_LIVE` 同时覆盖工具侧绕过 `when` 的调用；未知未来
  `turn/end` reason 归为 `interrupted`；删除死代码（`KnownSession`、`foldedTitle`、未用
  local）；所有导出补 JSDoc。

## 4. 工具与命令（`packages/tool`、`packages/command`）

- `listSessions` 契约迁移（signal 进入 options）；`requireAgent` 缺失调用者改为结构化
  `HarnessError(..., 'DEVLEAD_AGENT_NOT_LIVE')`；三个写工具转发 `exec.signal`。
- 命令解析对齐官方 `CommandInvocation.rawInput` 契约（命令名之后的文本，可能带分隔空白）：
  删除无依据的「完整命令行」容错，新增不配对引号/多词引用/未知子命令等明确错误；命令 handler
  里的附件分支按官方「`CommandRuntime` 在 handler 之前拒绝」删除（定义继续不声明 attachments）。
- 状态视图改为**一次 projection 读取**（模式 + watch 集合 + digest 来自同一快照）；状态行/
  候选/变更标题统一 `sessionRefLabel`（空白标题回退裸 id）；穷尽映射全部 `DEVLEAD_*` 错误码。
- 工具值：修正 schema 描述；加编译期 schema↔protocol 一致性断言与运行时 output schema 校验；
  `presentCall` 保持纯函数并裁掉空白填充参数；policy 文案与实际工具行为对齐（列表行有哪些
  字段、详情工具才有 `lastTransition/lastError/lastAssistant`），并验证关闭模式后下一步收紧。

## 5. 客户端 UI 与协议（`packages/client-ui`、`packages/protocol`）

- 浏览器 API 逐项对照 DSH 0.2.2-rc.1：slot 均为 `list`/`session`、标准 props 含
  `useProjection`/`useSessions`/`useSessionStatus`；`ctx.slots.inject` 本身有 fiber 级 effect，
  直接调用正确；`Switch`/`Button`/`Tooltip`/locale/icon props 与官方一致；浏览器 bundle 对
  `@deepseek-ai/*` 只 require platform module table 内的模块（第三方纯库可内联）。
- 两个入口的准入逻辑抽取为纯 gate+reducer + 薄 `useDevLeadAdmission` hook：同渲染周期双击只
  提交一条命令、卸载后不再 setState、模式变化作废旧失败；`ok:true` 但 Host 未解析到命令
  （`value: undefined`）不再被当成功（新增 `unresolved` 失败）。
- 可访问性：状态条提示/最新通知/图标失败都有 `role=status` live region，`aria-busy` 与
  pending 一致；样式改用 shell 的 menu-surface 模式（去掉重复 hairline、加 backdrop filter、
  toolbar 控件改为 28px glyph seat），所有 `--dsw-*` token 均确认存在并有中性 fallback。
- 协议：`excerptLine` 改为码点预算（不拆代理对、非法预算返回 undefined）；`notificationLine`
  空 `error` 不再吞掉有效 `summary`、空标题不再渲染 ` (id)`；未知转场映射与
  `formatInstant` 的 `RangeError` 边界写清并加测试；持久记录类型/消息词表用测试钉死（改名即
  数据迁移）；projection 类型增加 summary 排除标记。
- i18n：补 `error.unresolved` 等键；`locale/*.json` meta 与词典、占位符一致性由测试保证。

## 6. 构建、打包、安装与 CI

- `scripts/build.mjs`：删除从早期参考实现复制来的过期文档与未使用的 `assets` 机制；7 个 host
  产物不变；浏览器 external 列表单一来源 `scripts/client-externals.mjs`，与 DSH
  `platform.ts`/`seed.ts` 逐项同序一致，并加 **onResolve 守卫**（module table 之外的
  `@deepseek-ai/*` 浏览器导入直接构建失败）；bundle target 校验 patch/icon/files；`--only` 规范化；干净树重复构建字节一致。
- `scripts/install-profile.mjs`：全量预检（不再半链接失败）、校验 exports/main 与 bundle 产物、
  dry-run 计划、卸载真正 no-op、安装副本冲突拒绝；隔离 `/tmp` DSH_HOME 实测安装/卸载/重复执行。
- `scripts/dev-patch.mjs`：见 §2；新增 `--profile/--dsh-home/--no-link`、profile 校验与可操作
  错误（缺 profile → 创建专用 dev profile 的步骤；已启用 bundle → 拒绝重复 row id）。
- `scripts/check-packages.mjs`（新）：只读校验版本锁步、`engines.dsh`、repository 字段、
  peer 版本与根 devDeps 一致、**host 运行期 `@deepseek-ai/*` 导入必须是 peer**（linked root
  规则）、DSH 包不得作为直接/optional 依赖、不得声明实验包、浏览器 `@deepseek-ai/*` 导入
  必须在 module table、`dsh.client.inject` 与 root devDeps / 平台单例一致、workspace 依赖与
  导出子路径、tsconfig/vitest 别名、lockfile importers、CI action pin 一致。
- CI：新增 `.github/workflows/verify.yml`（push/PR：frozen install → typecheck → test → build →
  check-packages）；`publish.yml` 增加发布串行化、tag 一致性门禁沿用、GitHub Release 幂等；
  `trusted-publishers.sh` 改为能力探测（`npm trust --help`）并对私有包/`--list` 失败处理。
- `tsconfig.base.json` 开启 `noUnusedLocals` / `noUnusedParameters`（先清理死代码，再启用）。

## 7. 行为变更（面向使用者）

| 变更 | 影响 |
| --- | --- |
| `pnpm dev:patch` 需要 `--profile`（默认 `web` 通常不存在）且会写 linked root | 旧文档的 `dsh web --patch` 一条命令改为「专用 dev profile + 启动命令」；`--no-link` 只检查 |
| 身份解析不再受 `maxListedSessions` 限制 | 列表窗口外的会话也能用完整 id / 唯一前缀寻址 |
| `watchedOnly` 列表不会截断到小于 watch 集合 | 自定义配置下 `/devlead` 状态不再把被截断的 watch 行显示为 not found |
| `useWorkspace` 错误码细分 | 相对路径/文件 → `DEVLEAD_INVALID_INPUT`；缺目录 → `DEVLEAD_DIRECTORY_MISSING` |
| `title` 只作用于新注册 Workspace | 已注册路径保留原标题（工具描述已写明） |
| 写方法支持协作式取消 | 取消按 `AbortError` 拒绝；Session 创建本身不可中断 |
| `/devlead` 解析严格按 rawInput 契约 | 完整命令行不再被容错（真实客户端不会发送） |
| 通知去重/重试/归档 lead 行为 | 同一 `turn/end` 不会重复唤醒；失败按 1s 上限重试；归档 lead 暂停投递 |
| `devLead` 不进 Session summary | Session 列表/summary 传输更小；打开中的会话行为不变 |
| 严格解码 | 手工改坏的日志从「静默忽略」变为 `DEVLEAD_PROJECTION_INVALID` |

## 8. 验证矩阵

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck`（strict + exactOptionalPropertyTypes + noUnused*） | 通过 |
| `pnpm test` | 17 文件 / 399 测试通过（审计前 14 文件 / 294） |
| `pnpm build` | 7 个 `lib/*.js` + bundle 校验通过 |
| `pnpm check:packages` | OK（6 包） |
| `pnpm e2e`（patch 流，真实 DSH 0.2.2-rc.1） | 25/25 通过 |
| `pnpm e2e --flow installed` | 25/25 通过 |
| 干净树重复 build | 字节一致 |
| 隔离 DSH_HOME 安装/卸载脚本 | 通过（真实 `~/.dsh` 未被修改） |

E2E 断言链：boot graph 含 client plugin 与 injects → `/devlead` 命令注册与 grammar →
`devLead` 投影默认值 → `/devlead on` 成功且投影翻转 → 状态/自 watch 拒绝 → 真实子会话
watch → 子会话 `turn/end`（无模型凭据，稳定 provider error）生成持久通知并进入 lead 投影 →
`/devlead status` 展示 → `/devlead off` 翻转。实例在隔离 `DSH_HOME` 中按 PID 启停。

## 9. 遗留限制与风险

- 组件/Hook 的接线没有 React 渲染器单测（仓库不引入新依赖）：由 tsc + esbuild + 真实 DSH 的
  boot graph/E2E 覆盖；纯逻辑（准入状态机、格式化、locale、样式契约）有单测。两个 UI 状态
  （toolbar 图标 / 开启后的 DevLeadBar）在真实 Chrome 里对隔离 DSH 实例做过人工渲染验证，
  并据此刷新了 `docs/screenshots/devlead-toggle-off.png` 与 `devlead-bar.png`。
- 前缀解析（非精确 id）仍需要列出持久化语料；精确 id 有快路径。没有 `sessionQuery` 时只有
  live / watched 的精确 id 可解析（能力与之前一致）。
- `listSessions` 仍会为候选行批量读取一次标题/header（`createdAt` 排序需要 cold header）；
  这是一次批量 observation，不是逐条日志读取。
- 通知在此前已排队未投递的 notice 存在时不会重复唤醒（持久 digest 是权威，模型可调用
  `devlead_notifications`）；这是刻意设计。
- **`stateSchema` 的边界不变量（本轮修复）**：手工损坏的 checkpoint 中出现重复 watch id、
  重复 notification id、超出 `Date` 范围的 `at`、超过 64 条的 digest，或 id 与
  `sessionId/turn/transition` 不一致时，`stateSchema` 现在会校验失败；registry 丢弃该 cache
  行并重放完整日志，而不是恢复一个损坏或重复计数的状态。
- `dsh.client.inject` 中的 platform module 名字（如 client-ui-primitives）会被 loader 忽略，
  保留作为运行期依赖文档；`check-packages.mjs` 保证浏览器 `@deepseek-ai/*` 导入不越界。
- 发布路径（OIDC / GitHub Actions）无法在本地完整执行：workflow 语法、tag 门禁与打包选择已
  本地验证，真实发布仍需在 GitHub 上回归。

## 10. 后续打磨轮次（2026-11-09，文档与实现同步）

本节记录在上一轮全量审计之后的一轮代码/文档打磨；前面的历史章节保持原样，最新行为以本节、
[`DESIGN.md`](DESIGN.md) 与 [`OPTIONAL-DEPENDENCIES.md`](OPTIONAL-DEPENDENCIES.md) 为准。

**正确性与边界**

- `createSession` 在第一个 await 前同步预留 watch 槽位，并发/交错调用不再出现"已建 Session
  但 watch 超限"的 orphan；watch 提交后立即释放预留。
- 创建前校验目标 Workspace 的 `status() === 'ok'`，阻止 controller 对已消失目录自动 mkdir
  复活空目录。
- 持久 watch 记录若包含 lead 自身 id，hub 在索引时忽略并 warning；`record` 也有重入防御。
- command 的前缀引用在 watch/unwatch 前用 core 穷尽 resolver 复核，避免有界列表外的同前缀
  Session 被静默遮蔽；`watchedOnly` 显式小 limit 也不会截断 watch 集合。
- 严格边界：excerpt 长度/码点、`at` 的 Date 上界、digest ≤64、notification id 一致性、
  重复 watch/notification id 都会让 replay/cache 校验失败；`lastError` 收敛为 bounded excerpt。
- worktree 服务返回畸形 checkout 时降级为 `failed`；`notificationBatchMs` 拒绝超过 Node timer
  上限的值。

**安全、工具链与 E2E**

- `e2e-smoke.mjs --root` 使用真实 containment + scratch marker，拒绝删除非本脚本目录；子进程
  环境按凭据模式清理；readiness 超时先终止子进程。
- `devlead_use_workspace` 工具要求 live 调用者；core `useWorkspace` 的 caller-free API 例外已
  在 README/DESIGN 明确。
- `check-packages.mjs` 支持多行/副作用/动态 import，新增 DSH 直接依赖、实验包、
  `dsh.client.inject` 与 root devDeps/module table 的校验；publish workflow 在发布前也运行该
  检查。
- E2E 新增 `Session-list summary excludes the digest-bearing devLead projection` 断言；
  patch 与 installed 两条加载流均为 **33/33**。

**文档**

- README / README.zh：更新 worktree 能力条件、cold/disposed lead 语义、配置取值范围、
  command 前缀校验、blank 行标记限制、`useWorkspace` 权限例外、package README 导航。
- DESIGN：同步并发预留、Workspace 目录校验、schema 边界、command 前缀复核、E2E 凭据/临时目录
  语义、worktree 结果校验与错误表。
- OPTIONAL-DEPENDENCIES：同步 check-packages 新规则、worktree 畸形结果、验证计数与 E2E 两条流。
- 各包新增简短 README（protocol / devlead / tool / command / client-ui），bundle README 同步
  cold lead、blank 行与 E2E 运行方式。

**验证（最终工作树）**

- `pnpm verify` exit 0（21 文件 / 467 tests，6 个构建 target）。
- `node scripts/check-packages.mjs` → `OK (6 packages)`。
- `node scripts/e2e-smoke.mjs --no-build --flow patch` 与
  `node scripts/e2e-smoke.mjs --no-build --flow installed` → 各 33/33 通过。

**仍需决策**：`isolation` 必填字段对应的 minor 版本发布；cold lead 的持久化索引重建；
`useWorkspace` 是否改为 Agent 参数/默认不建目录；`promptSession` resume/admission 失败后的
半 watch 补偿；`hasQueuedNotice` 丢弃 batch 的语义；真实实验组合下的 worktree happy path 验收。
