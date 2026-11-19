# 审计记录：DevLead 套件对 DSH 0.2.2-rc.1 的全面核验与修复

本文件记录一轮对整套插件的**全量审计、优化与打磨**：审计基准是官方 DeepSeek Harness
`0.2.2-rc.1` 源码（`/Users/guoyk/Workspace/src/deepseek-harness`，与本套件安装的
`@deepseek-ai/*` 同一版本）以及已安装包的声明；第三方插件（包括早期参考过的
`dsh-infini-goal`）只作为线索，不作为依据。审计覆盖 6 个包与全部脚本/CI/文档，逐项核验
DSH API 语义、错误路径、并发与生命周期、性能、打包与安装路径，并补齐回归测试与本机真实
DSH 端到端验证。

> **快照说明**：本文件 §1–§9 是**上一轮**全量审计的历史记录，其中的测试 / E2E 计数（399 tests、
> 25/25 checks）记录的是当时的工作树。此后工作树新增了可选 worktree 隔离与依赖姿态审计
> （0.1.1），并完成了 **0.2.0** 的六个决策项与 nits（见 §10.2）。**本轮（0.2.6+ 工具面审计）
> 见 §12**；其余最新验证数字与结论见
> [`DESIGN.md`](DESIGN.md) §10 与 [`OPTIONAL-DEPENDENCIES.md`](OPTIONAL-DEPENDENCIES.md)
> （本文件 §1–§9 是历史快照；下列为 **v0.2.6 发布时点**数字：26 文件 / 755 tests。rc.5 补测：installed/patch 各 143/143、`--no-worktree` 120/120；rc.4 同；rc.1–rc.3 `--no-worktree` 各 120/120。完整矩阵见 [COMPATIBILITY.md](COMPATIBILITY.md)）。

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

> 0.2.4 变更：模式开关已统一到 composer toolbar 的 `DevLeadIconToggle`（两态常驻）；
> `DevLeadBar` 只读且不再导入 `Switch`。以下 §5 记录的是 0.2.0 审计时点，实现以
> `docs/DESIGN.md` §7 为准。

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
  （0.2.0 之后发布流程已改为 **npm staged publish**：CI 只 stage、维护者人工 approve 后才公开，
  GitHub Release 由本地脚本创建；以 [`docs/PUBLISHING.md`](PUBLISHING.md) 当前内容为准。）
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

- ~~组件/Hook 的接线没有 React 渲染器单测（仓库不引入新依赖）~~：0.2.0 已补
  `react-test-renderer` 渲染测试（纯 node、无 jsdom，见 §10.2 D8(e)）；此前的覆盖来自
  tsc + esbuild + 真实 DSH 的 boot graph/E2E，两个 UI 状态（toolbar 图标 / 开启后的
  DevLeadBar）也在真实 Chrome 里对隔离 DSH 实例做过人工渲染验证，并据此刷新了
  `docs/screenshots/devlead-toggle-off.png` 与 `devlead-bar.png`。
- 前缀解析（非精确 id）仍需要列出持久化语料；精确 id 有快路径。没有 `sessionQuery` 时只有
  live / watched 的精确 id 可解析（能力与之前一致）。
- `listSessions` 仍会为候选行批量读取一次标题/header（`createdAt` 排序需要 cold header）；
  这是一次批量 observation，不是逐条日志读取。
- ~~通知在此前已排队未投递的 notice 存在时不会重复唤醒~~：0.2.0 改为**保留 pending、
  1s recheck**（inbox 里的 notice 被消费/取消后立即补投，不再丢唤醒；持久 digest 仍是权威，
  模型可调用 `devlead_notifications`），见 §10.2 D5。
- 损坏的 `plugin:devlead/*` 记录不再不可恢复：人类可运行 `/devlead reset`（或冻结时
  `/devlead off`）追加 reset 记录并从空状态重来；旧版本无法执行该恢复（见 §10.2 D6）。
- **`stateSchema` 的边界不变量（本轮修复）**：手工损坏的 checkpoint 中出现重复 watch id、
  重复 notification id、超出 `Date` 范围的 `at`、超过 64 条的 digest，或 id 与
  `sessionId/turn/transition` 不一致时，`stateSchema` 现在会校验失败；registry 丢弃该 cache
  行并重放完整日志，而不是恢复一个损坏或重复计数的状态。
- `dsh.client.inject` 中的 platform module 名字（如 client-ui-primitives）会被 loader 忽略，
  保留作为运行期依赖文档；`check-packages.mjs` 保证浏览器 `@deepseek-ai/*` 导入不越界。
- 发布路径（OIDC / GitHub Actions）无法在本地完整执行：workflow 语法、tag 门禁与打包选择已
  本地验证，真实发布仍需在 GitHub 上回归。

## 10. 后续打磨轮次（2026-11-09，文档与实现同步）

本节记录全量审计之后的两轮代码/文档打磨；前面的历史章节保持原样，最新行为以本节、
[`DESIGN.md`](DESIGN.md) 与 [`OPTIONAL-DEPENDENCIES.md`](OPTIONAL-DEPENDENCIES.md) 为准。
§10.1 是 0.1.1 的打磨记录（历史）；§10.2 是 **0.2.0**：上一轮遗留的六个"仍需决策"项与
nits 已全部拍板并落地，含 breaking 影响与 file/test 证据。

### 10.1 0.1.1 打磨（历史）

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
- `devlead_use_workspace` 工具要求 live 调用者（0.2.0 起 core `useWorkspace` 也接收 Agent，
  见 §10.2 D3）。
- `check-packages.mjs` 支持多行/副作用/动态 import，新增 DSH 直接依赖、实验包、
  `dsh.client.inject` 与 root devDeps/module table 的校验；publish workflow 在发布前也运行该
  检查。
- E2E 新增 `Session-list summary excludes the digest-bearing devLead projection` 断言；
  patch 与 installed 两条加载流均为 **33/33**（0.2.0 扩为多阶段 1 / 1b / 2，见 §10.2）。

**文档**

- README / README.zh：更新 worktree 能力条件、cold/disposed lead 语义、配置取值范围、
  command 前缀校验、blank 行标记限制、`useWorkspace` 权限例外、package README 导航。
- DESIGN：同步并发预留、Workspace 目录校验、schema 边界、command 前缀复核、E2E 凭据/临时目录
  语义、worktree 结果校验与错误表。
- OPTIONAL-DEPENDENCIES：同步 check-packages 新规则、worktree 畸形结果、验证计数与 E2E 两条流。
- 各包新增简短 README（protocol / devlead / tool / command / client-ui），bundle README 同步
  cold lead、blank 行与 E2E 运行方式。

### 10.2 0.2.0：六个待决策项与 nits 全部落地

上一轮 §10 末尾"仍需决策"的六项（`isolation` 必填字段发布、cold lead 索引重建、
`useWorkspace` 参数/默认建目录、`promptSession` 半 watch 补偿、`hasQueuedNotice` 丢 batch、
真实实验组合下的 worktree happy path）已全部按**正确语义**拍板并实现；六个 nits 一并修复。
0.2.0 是 minor（0.x 允许 breaking），不 tag、不发布，改动留在工作树。

| # | 决策项 | 选定行为 | 理由 | Breaking 影响 / 兼容 | 实现（file:symbol） | 测试证据 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | `DevLeadCreatedSession.isolation` 必填字段的发布声明 | 正式声明为 0.2.0 breaking；`isolation` 语义不变。tool 的 value 层保留对旧 core 缺失该字段的防御性回退 `{ requested:'none', status:'none' }` | 0.x minor 允许 breaking；混装旧 core + 新 tool 不崩溃，但不再是被支持的发版组合 | 直接读 `created.isolation` 的宿主插件需升级 core；6 包应整体升级 | `packages/protocol/src/types.ts`（`DevLeadCreatedSession.isolation`）；`packages/tool/src/value.ts`（回退） | `packages/tool/tests/tools.spec.ts`（isolation 四态投影）；`packages/devlead/tests/service.spec.ts`（创建结果） |
| D2 | cold lead 索引重建 + `wakeColdSession` 默认值 | Host 重启/插件重载后，`[Service.init]` 在 `hub.start()` 后跑冷扫描（`hub.rehydrate(persistedLeadRecords())`）：live 无 Agent 会话直接 fold；persisted 候选经 projection cache 零 I/O 预筛 + `readSession` 精确 fold（unknown 全量读取上限 64，cache 明确 enabled 的候选不计入、明确 disabled/空 watch 的直接跳过；无 cache 服务时冷扫描完全不读日志、只一次 warning）；`rehydrate` 幂等、不要求 Agent/Session live。**就绪条件是 `sessionQuery` + 可选 `sessionPersistence` 双双组合**（query engine 异步绑定 persistence 前 `listSessions()` 只返回 live-only 行）：init **await** 一个 corpus-readiness barrier——live-attach 回退 → 一个 macrotask → 用 `src/persistence.ts` 的 `persistedSessionsOf` 读取 `sessionPersistence.list()` 的完整存储会话 id：0 个则立即就绪；否则每 100ms 轮询、有界 2s 等 `sessionQuery` 的 persisted 行包含全部 id，超时 warning + best-effort；随后**唯一一次**权威 cold scan，标记 `rehydrated` 并解绑重试（Host 在索引重建前不会报告 application-ready）。in-process `agent/disposed` 保留 lead runtime 与反向索引，因此 dispose 后仍观察 watched 会话、继续写持久通知。`wakeColdSession` 默认改为 `true`：冷 lead 有队列时 `resolveAgent` 后补写并投递；`false` 保留队列等人类打开。E2E 阶段 1b 在真实 Host 上暴露并修复了最初的 readiness 竞态（`sessionQuery` 已存在但 persistence 绑定未就绪 → 空语料），最终实现以双就绪为权威条件 | 现存缺陷：`bootstrap()` 只看 live Agent、冷 lead 不产生任何通知；DevLead 的职责就是被 watched 会话的 turn/end 唤醒，Host 重启后仍应如此 | **默认值变更**：升级后 Host 重启会自动 resume 冷 lead 投递（不希望后台 resume 的部署显式设 `wakeColdSession:false`） | `devlead/src/index.ts`（`MAX_COLD_LEAD_LOG_READS`、`REHYDRATION_READINESS_TIMEOUT_MS`/`POLL_MS`、`rehydrated`、`[Service.init]`、`rehydrateFromPersistence`、`runRehydration`、`awaitCorpusReady`、`finalizeRehydration`、`armRehydrationRetry`、`persistedLeadRecords(scanPersisted)`）；`devlead/src/persistence.ts`（`persistedSessionsOf` 只读探针）；`devlead/src/notification.ts`（`DevLeadPersistedLead`、`rehydrate`、`unsaved`、`persistUnsaved`、`flush`）；`devlead/src/projection-cache.ts`（`projectionCacheOf`/`devLeadPrefilterOf`） | `packages/devlead/tests/service.spec.ts`（`FakeSessionQuery`/`FakeProjectionCache`、cache 预筛、精确折叠损坏跳过、live 无 Agent、默认 true、`waits for the optional persistence binding before adopting cold leads`、`waits out a stale corpus listing before the authoritative scan`、`loads and serves live leads when the corpus never becomes consistent`、`runs the readiness scan once and stops retrying after it`、`does not scan the persisted corpus on events while persistence is absent`、`keeps the one-shot rehydration retry armed until the query engine exists`、`rehydrates only live leads when no projection cache is composed`、`never fails the plugin load when the persisted scan rejects`）；`packages/devlead/tests/notification.spec.ts`（`rehydrate` 幂等、unsaved 补写、`wakeColdSession:false` 不投递）；E2E 阶段 1b（真实 Host 重启后冷 lead 从持久日志重建索引并产生新通知） |
| D3 | `useWorkspace` 的调用者与默认建目录 | core 新签名 `useWorkspace(agent, { path, title?, create? }, signal?)`；先 `assertReady`（live + 模式开启）；**`create` 默认 `false`**：默认绝不 mkdir，缺目录报 `DEVLEAD_DIRECTORY_MISSING`（文案提示 retry with `create: true`），只有显式 `true` 才 `mkdir -p` 后重试一次 | Workspace 注册是 Host 级副作用；目录创建影响大，模型必须先征得人类显式同意；tool 与 core 语义统一 | **core API breaking**：`useWorkspace(path, options)` 调用方改为传 Agent + request；行为上"缺目录自动创建"变为显式 opt-in | `devlead/src/index.ts`（`useWorkspace`）；`tool/src/index.ts`（`devlead_use_workspace`）；`tool/src/policy.ts`；`protocol/src/types.ts`（`DevLeadUseWorkspaceRequest`） | `packages/devlead/tests/service.spec.ts`（模式关闭/非 live/默认不 mkdir/显式 true 才 mkdir/title 只作用新记录）；`packages/tool/tests/tools.spec.ts`（默认 false 转发、显式 true、signal 转发、schema 描述） |
| D4 | `promptSession` 自动 watch 的失败/取消补偿 | 采用**补偿**而非"admission 成功后再 watch"：`added` 时 admission 前 `setWatching(true)`（否则极快的 turn/end 会落在 watch 之前丢第一次唤醒）；admission/resume 失败或取消时，用不带 signal 的 `setWatching(false)` 移除**本次新增**的 watch（失败只 warning），再抛原错误；已有显式 watch 与 `watch:false` 不改变 | 半应用状态（watch 了但没投递）不可接受；"先 admission 再 watch"会丢第一次通知 | 语义收紧：失败/取消不再留下本次新增的 watch；成功路径 `watched` 仍从 durable state 读取 | `devlead/src/index.ts`（`promptSession` 的 `alreadyWatched`/`added`/补偿） | `packages/devlead/tests/service.spec.ts`（admission 抛错、resume 抛错、取消、已 watch 不受影响、`watch:false` 不变） |
| D5 | `hasQueuedNotice` 丢 batch | **保留 pending、不投递也不丢弃**：inbox 已有未投递 devlead notice 时不取 batch，arm 1s recheck timer（复用 `runtime.timer`）；recheck 时 notice 已消费/取消则正常投递，仍排队则继续等；`agent/status` idle 钩子立即重试。持久 digest 始终权威（记录先写） | 旧行为新 batch 可能永远不再触发唤醒（持久记录在、唤醒丢） | 行为修正，无 API 变化：inbox 有 notice 时唤醒延后到 1s 内或 idle 时，而不是被丢弃 | `devlead/src/notification.ts`（`flush` 的 `hasQueuedNotice` 分支、`scheduleRetry`、`DELIVERY_RETRY_MS`） | `packages/devlead/tests/notification.spec.ts`（第二个 batch 保留、`drainInbox` + 推进 1s 只投一次、`cancelInbox` 边界、unwatch/模式关闭/dispose 清理 timer） |
| D6 | 损坏 fold 的恢复路径 | 新增持久记录 `plugin:devlead/reset`（`{ kind:'devlead/reset', version:1, at }`）；两个投影 fold 在冻结检查**之前**处理 reset：合法 reset 回到空状态（disabled、空 watch、空 digest、failure:null），坏 payload 保持冻结。core 新增 `reset(agent, signal?)`（只 `assertLive`）；`setEnabled(false)` 在冻结时写 reset 恢复，`setEnabled(true)` 抛 `DEVLEAD_PROJECTION_INVALID` 提示先 reset。command 新增人类专属 `/devlead reset`；`/devlead off` 在冻结时直接走恢复路径；错误文案提示 reset 并说明会丢弃 watch/digest | 一条损坏记录永久锁死会话不可接受；但隐式丢弃人类可能想检查的记录同样不可接受，所以恢复必须是显式人类动作 | **新增持久记录类型**（旧版本 fold 会忽略它：不崩溃但无法恢复）；新增 core 方法 `reset()` 与命令 `reset`；恢复后旧记录保留在日志但不再 fold | `protocol/src/types.ts`（`DEVLEAD_RESET_RECORD_TYPE`、`DevLeadResetRecord`）；`devlead/src/domain.ts`（`resetRecord`、`decodeResetRecord`）；`devlead/src/fold.ts`（两个 `apply*Projection` 的 reset 分支、`freezeProjection`）；`devlead/src/index.ts`（`reset`、`setEnabled` 冻结分支）；`devlead/src/notification.ts`（`onSessionEvent` 对 reset 也 `syncLead`）；`command/src/parse.ts` / `index.ts` / `render.ts` | `packages/devlead/tests/fold.spec.ts`（reset 解冻两投影、坏 reset 不解冻、reset 后正常 fold）；`service.spec.ts`（setEnabled off 恢复、on 报错、reset 幂等、hub 索引清空）；`packages/command/tests/parse.spec.ts` / `handler.spec.ts`（parse/usage、reset 渲染、off 冻结恢复、status 冻结友好错误） |

nits（D8）：

| nit | 选定行为 | 实现（file:symbol） | 测试证据 |
| --- | --- | --- | --- |
| (a) `ensureStyleTag` 跨实例 refcount | 以 `Symbol.for(...)` 为 key 挂在 `globalThis` 的共享状态 `{ refs, element }`：首个实例创建 `<style>`，后续实例复用并刷新 `textContent`，每个 disposer 递减、归零才移除，避免 HMR 新旧模块实例交替时旧 disposer 删掉新实例仍在用的标签 | `client-ui/src/client/styles.ts`（`ensureStyleTag`） | `packages/client-ui/tests/styles.spec.ts`（多次调用；`vi.resetModules()` + 动态 import 模拟第二模块实例；旧实例 dispose 后标签仍在；全部 dispose 后移除） |
| (b) command 并发点击 title/body 不一致 | `executeMode`/`executeWatch` 变更后重新取一次快照，title 由 post-mutation 快照的真实状态派生、body 永远来自同一快照（如 "DevLead mode is off (another command changed it)."） | `command/src/index.ts`（`modeTitle`、`watchTitle`、`snapshotWatches`） | `packages/command/tests/handler.spec.ts`（fake 在 mutation 中翻转/回滚状态，断言 title 与 body 一致） |
| (c) 通知记录崩溃窗口未 flush | `record()` 追加通知记录后 fire-and-forget `ctx.sessions.flush(session)`（失败 warning，不影响投递）；digest 投递时既有 flush 保留 | `devlead/src/notification.ts`（`appendNotificationRecord`、`checkpoint`） | `packages/devlead/tests/notification.spec.ts`（harness 记录 flush 次数 / 失败路径） |
| (d) `warnedFailures` dispose/reopen 后重复 warning | 有界集合（上限 256，FIFO 淘汰），`removeLead` 不再清；只在 `stateOf` 读回有效状态时删除该 id：同一损坏 Session 一个 Host 生命周期只 warning 一次 | `devlead/src/notification.ts`（`warnedFailures`、`trimWarnedFailures`、`removeLead`）；protocol 常量 | `packages/devlead/tests/notification.spec.ts`（dispose/reopen 不重复 warning、reset 后恢复可再 warning） |
| (e) React 组件/hook 渲染测试 | 新增 devDependency `react-test-renderer@18.3.1` + `@types/react-test-renderer`（纯 node、无 jsdom，与仓库 React 18 对齐）；组件把 `useProjection`/`useSessions`/`useSessionStatus` 作为 props，因此只 mock `@deepseek-ai/dsh-client-ui-primitives`；用 `act` 驱动 | 根 `package.json`（devDependencies）；`packages/client-ui/tests/*.spec.tsx` | 覆盖 DevLeadBar enabled/disabled、SR live region/label、pending 禁用、失败文案；DevLeadIconToggle 分支与隐藏失败活区；SessionMark/HoverMark；`useDevLeadAdmission` 单击提交、双击单次提交、卸载不 setState、失败保留与 `resetKey` 清空 |

**验证（0.2.0 最终工作树）**

- `pnpm verify`：typecheck 通过 + **22 文件 / 558 tests**（`pnpm test`）。
- `pnpm build`：7 个 `lib/*.js` 与 bundle 校验通过。
- `node scripts/check-packages.mjs` → `OK (6 packages)`。
- E2E 多阶段（默认 profile 全量断言 + 重启验证冷 lead 索引重建（阶段 1b，D2 的端到端证据）
  + 叠加实验 bundle 的 worktree happy path（阶段 2））：`node scripts/e2e-smoke.mjs --no-build
  --flow patch` 与 `--flow installed` → 各 **61/61**（阶段 1 27 + 阶段 1b 12 + 阶段 2 22）；
  `--no-worktree` 跳过阶段 2 → **39/39**（阶段 1 + 1b）。
- 版本：根 `package.json` 与 6 个可发布包均为 `0.2.0`；`check-packages` 校验版本锁步。

**文档（0.2.0）**：README / README.zh 同步配置默认值（`wakeColdSession` true、`create`
默认 false）、cold rehydration、`/devlead reset`、通知 queued-notice 语义与多阶段 E2E；
DESIGN 更新 §3 记录表（reset）、§4 API/约束/promptSession 补偿、§4.1/§4.1.1 冷 lead 重建、
§6 命令与恢复、§8 错误码、§9 测试策略、§10 多阶段验收、§11 非目标；AUDIT §10 即本节；
PUBLISHING / OPTIONAL-DEPENDENCIES 与各包 README 同步；`docs/releases/v0.2.0.md` 为发布说明。

## 11. 0.2.4 全量审计与 rc.1–rc.4 兼容轮（本轮）

本轮以 npm 临时安装的 DSH `0.2.2-rc.1` / `rc.2` / `rc.3` / `rc.4` CLI 为真实运行时复核，
并对 6 个包做代码审计。结论：**rc.1–rc.4 全部支持，无降级项**。关键事实与修复：

- **rc.4 差异极小**：`dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 与 rc.3 逐字节一致；
  唯一 upgrade-guide 条目是 DeepSeek 流式拒答错误码 `MALFORMED_RESPONSE` →
  `CONTENT_REFUSED`，DevLead 不分类 LLM 错误码。`dsh-agent`、`dsh-session`、`dsh-tools`、
  `dsh-commands`、`dsh-workspace`、`dsh-session-projection`、`dsh-session-query`、
  `dsh-api-session-controller`、`dsh-agent-preset-registry`、`dsh-agent-team` 的 `.d.ts`
  在 rc.3→rc.4 无变化；rc.2→rc.3 的 UI 槽位变化是新增（`workspace.picker` Factory），
  DevLead 用到的 4 个槽位在 rc.1 已存在。
- **peer 依赖姿态**：`@deepseek-ai/dsh-*` 与 `zod` 的 peer 从精确 pin 改为
  `>=0.2.2-rc.1 <0.3.0` / `^4.4.3`。DSH 加载器只按 `engines.dsh` 判定兼容（有
  `engines.dsh` 时忽略 peers），但 profile 的 pnpm peer 检查会因精确 pin 在 rc.2+ 上报
  unmet peer；范围修复了该噪声。`scripts/check-packages.mjs` 改为「root devDependency
  必须落在 peer 范围内」，并新增 `semver` devDependency。devDependencies 仍固定 rc.1，
  以最旧 API 做类型检查。
- **E2E 矩阵**：rc.1–rc.3 `--no-worktree` 各 120/120；rc.4 installed 与 patch 各 143/143
  （阶段 3 新增 agent preset roster 检查：rc.1–rc.4 都返回 `standard` 为默认的真实 roster；
  新增 watched-child 汇报检查：子会话真实 step 只看到 `devlead_report`、收到单向 policy，
  真实 report 写入 lead digest）。
- **中途汇报（当前工作树）**：新增 `plugin:devlead/report` durable 记录与 `reports`
  projection 数组；`devlead_report` 仅在「非 DevLead + 唯一 active lead watch」时可见；
  `reportProgress` 同步解析关注该会话的 active lead，异步投递复用通知 hub 的 pending/unsaved 队列与合并
  唤醒；同轮相同 message 幂等，每轮 4 条上限，返回 `DEVLEAD_NOT_SUPERVISED` /
  `DEVLEAD_REPORT_RATE_LIMITED` / `DEVLEAD_INVALID_INPUT`；lead 状态条、`/devlead` status、
  `devlead_notifications` 均展示 report。
- **报告持久化（遗留风险 A）**：工具成功前先写 `storageDomain` 的 durable outbox
  （`devlead_report_outbox`，per-record 原子写），lead receipt 只有在
  `ctx.sessions.flush` 成功后才删除 outbox 行；cold/archived/未 attached lead 保留行，在
  service init、storage 晚挂载、`agent/created`、`setEnabled(true)`、`watchSession(true)` 时
  replay。7 天 retention；`/devlead reset` 丢弃该 lead 的待投递行；Host 无 storage 时回执
  `durable:false` + warning。E2E 新增 `durable:true/queued:false` 断言。
- **archived 占用者（遗留风险 B）**：archived DevLead holder 不再阻塞准入；release 失败时写
  `ignored` tombstone、warning、继续准入。`/devlead status` 新增
  `Archived DevLead holders (ignored for admission)` + unarchive/off/delete 指引；unarchive
  + `agent/created` reconciliation 会在 live Session 上写 mode-off 并清除 tombstone，避免双活。
  26 文件 / 755 tests，E2E 143/143（phase 3 81）。
- **审计修复**（详见 release notes 0.2.4）：cold-lead 扫描先 rank 后读标题（避免为截断前
  的每个冷 Session 读完整日志）；corpus readiness 双重限时且 dispose 可唤醒；冷 lead
  resume 失败有界重试；通知 append 失败进入 `unsaved` 而不是当作已 durable；归档但运行中的
  Session 状态行不再自相矛盾；`/devlead` 支持中文 IME 弯引号并正确诊断闭合引号后的多余文本；
  工具错误保留 `cause`；`lastTurn: 0` 哨兵不再泄漏；exhaustive 身份解析在 query 失败时
  报 `DEVLEAD_SESSION_UNAVAILABLE` 而不是静默退化为 live-only；模式/watch/reset 后主动
  checkpoint projection cache，缩小 stale-negative 窗口。
- **UI**：失败 tooltip 可点击固定阅读（触屏可达），移除与 Tooltip 冲突的原生 `title`，
  失败态 hover 不再覆盖错误色，窄屏隐藏冗余标签/过期计数，文字对比度改用 label token，
  pressed 态增加背景，圆角与相邻 composer 卡片统一。

## 12. 0.2.6+ 工具面与代码质量全面审计（2026-11-19，本轮）

本轮以**模型可见工具面**为重点，对 6 包做全面审计、优化与打磨。方法：lead 逐工具深审
`packages/tool`，同时并行 4 个只读审计子代理分别覆盖 devlead 核心、command+protocol、
client-ui/文案、文档一致性；发现整合后由 lead 与两个实施子代理在**不相交写作用域**内落地，
lead 审查全部 diff 并统一提交。审计基准 main @ `44753c4`（0.2.6，watched 提问路由未推送），
运行行为以本机安装版 **DSH 0.2.2-rc.5** 为准；工具面判据采用官方 dsh-doc `tool-design`
准则（"每个事实只说一次 / 参数规则放参数上 / 描述行为而非实现"）。

### 12.1 结论摘要

- **4 个 P0 真 bug（全部修复并附回归）**，都在 devlead 核心、且都触及 0.2.4–0.2.6 新功能的核心通道：
  1. `reportProgress` 幂等键只按 message、忽略 kind —— 同文 `question` 被先前 `progress` 回执吞掉，
     而 question 门禁（44753c4）恰会把子会话刚汇报过的原文转成 question report，导致 lead 永远收不到
     该提问、子会话被告知"结束 turn 等回答"而静默卡死。修复：幂等键 = `kind + '\0' + message`，与
     durable report id 语义对齐（同 kind 同文仍幂等）。
  2. `hasQueuedNotice` 对无 `source` 的 inbox 消息抛 TypeError，且调用点在 flush 的 try 之外 ——
     rc.5 inbox 投影用 `z.custom` 恢复持久化消息、不校验形状，损坏/迁移日志可致未处理拒绝
     （Node 默认崩溃进程）+ digest 批永久滞留。修复：`source?.kind` 防御 + 调用点 try/catch 降级为投递。
  3. dispose 不 await `outbox.close()` —— rc.5 storageDomain 单开，域名仅在完全 close 后释放；
     插件重载时新实例 open 撞 `already-open` 被 catch 成 undefined，本世代 durable 报告永久降级
     `durable:false`。修复：disposer 返回 close 的 Promise（cordis 等待）；`FakeStorageDomain` 加单开
     语义使该竞态对测试可见，并补重载回归。
  4. `promptSession interrupt` 已发出 stop 后 `followup` 失败时，外层补偿回滚本次新增 watch ——
     子会话被停止、替代 prompt 未投递、还失去 watch，比不 interrupt 更糟。修复：新增
     `DevLeadInterruptedAdmissionError`，stop 已提交则**保留 watch**（不补偿），文案提示重试；
     DESIGN §4 补偿语义补此例外。
- **工具面**：修复 `devlead_notifications` 描述残句（P0 文案）；按官方准则去重描述（总字符
  10298 → 8613，-16%），把 preset/model/teams/interrupt/stop_running 等参数规则收敛到参数上；
  补 8 个参数的 `default` schema 注解；6 个只读工具声明 `isConcurrencySafe`（可并行批处理）；
  report kind 枚举改从 `DEVLEAD_REPORT_KINDS` 单一来源派生（输入/输出两处 + 穷尽性测试），删 `as` 断言；
  披露 notifications limit 分别作用两个 digest、get_session 自读最近 5 条 report；补 prompt/watch 输出字段描述。
- **command/protocol**：archived 占用者标题改经 `sessionRefLabel` 单行折叠（防换行注入）；idle 会话
  也显示排队输入；本地匹配器镜像 core 的裸 uuid 头规则；引号诊断覆盖反向引号对/尾部 opener，剥离零宽粘贴噪声；
  `sessionRefLabel` 收敛到 protocol 单一来源；`presentLine`/`reportLine` 加 wire-drift 防御；钉死 reset 记录词表。
- **client-ui**：report 详情红字改中性色（error 红保留给真正的 turn 失败摘录）；hint/hover 文案补
  report/question 唤醒通道；删 archived 拒绝死分支；admission 在途竞态（resetKey 代际）；行标记 O(N²) →
  WeakMap 快照缓存；原型键 own-property 防御；paint-inset token 补 fallback。
- **文档**：中英 README/DESIGN/COMPATIBILITY/OPTIONAL-DEPENDENCIES/各包 README 共 17+ 项一致性修复
  （kind 枚举补 question、预算 question 豁免口径、when 门控、projection/记录清单补 reports、E2E 计数、
  v0.2.7 叙事、交叉引用、三寻址矩阵行等）。
- **验证**：`pnpm verify`（typecheck + **26 文件 / 821 tests** + build）通过；`pnpm check:packages` OK（6 包）；
  安装版 rc.5 `pnpm e2e` **installed 与 patch 双流各 146/146**（phase 1 27 + 1b 12 + 2 23 + 3 84，3 条正向
  model 检查因无凭据 SKIP）。基线 755 tests → 821（净增 66，均为边界/竞态/drift 回归）。

### 12.2 工具面变更前后对照表

**工具名 / 参数名 / 必填性 / 输出形状：零破坏性变更**（14 工具名、参数集合、required、canonical JSON
形状全部不变，rc.1–rc.5 兼容面不回退）。变更均为**非破坏**的描述/schema 注解/行为收紧：

| 维度 | 变更前 | 变更后 |
| --- | --- | --- |
| 工具名 | 14 个 `devlead_*` | 不变（评估过合并/改名，见 §12.3，建议不做） |
| 参数 `default` 注解 | 仅描述文本写默认值 | create/watch/isolation/interrupt/stop_running/limit/kind 共 8 处补 schema `default` |
| report kind 枚举 | index.ts/value.ts 两处硬编码 + `as` 断言 | 均 spread `DEVLEAD_REPORT_KINDS`，删 `as`，加穷尽性测试 |
| message/summary 上限文案 | "max 4000/200 characters" | 从 protocol 常量插值，明确 Unicode code points |
| 只读工具并发 | 默认 exclusive 串行 | 6 个只读工具 `isConcurrencySafe: () => true` |
| 输出字段描述 | prompt/watch 输出字段无 description | 补全（尤其 watch `sessions` = 变更后完整 watch 集） |
| notifications 描述 | 残句 "...from watched read it."；limit 仅说通知 | 修复残句；明确 limit 分别作用通知/汇报两个 digest、均 newest last |
| get_session 描述 | 未披露自读 report 上限 | 明确"最近 5 条"（命名常量 `SELF_REPORTS_LIMIT`） |
| stop_running 授权口径 | 参数"仅当人类要求" vs 主描述/judgment 矛盾 | 统一为 judgment-based（与主描述/policy/README 一致） |
| report 幂等口径 | "identical messages deduplicated" | "同 kind+message 幂等（同文不同 kind 是新报告）"，描述/policy/文档同步 |
| 描述总字符 | 10298 | 8613（-16%），逐工具见下 |

逐工具描述字符数（前 → 后）：list_models 496→348、list_agent_presets 775→669、list_workspaces 331→331、
use_workspace 303→261、list_sessions 508→508、create_session **2112→1323**、get_session 536→445、
prompt_session 999→706、watch_session 377→377、notifications 533→544、report 992→913、
remove_workspace 883→822、archive_session 1149→1062、unarchive_session 304→304。
去重原则：参数规则移到参数描述、跨工具规则移到归属工具，测试断言随之移到规范位置并**保持强度**
（新增"描述不再重复参数规则"的反向断言）。policy 两侧补 question 拦截的"人类直聊 turn 豁免"与
kind+message 幂等口径；policy 预算基线 JSDoc 修正为 0.2.7 / 10839。

### 12.3 破坏性变更决策（lead 已确认：全部不做）

以下均**未实施**，已用 `devlead_report` 给出方案与兼容策略。**lead 于 2026-11-19 明确确认
四项工具面评估全部「不做」**（archive/unarchive 不合并——stop_running 危险语义独立触发更精准；
use_workspace 不改名；watch_session 输出字段不改名、只补 description；list_* 不合并），
理由成立，按此执行。错误码/哈希两项仍为暂缓建议：

| 候选 | 评估 | 建议 |
| --- | --- | --- |
| 合并 archive/unarchive 为单工具布尔参数 | archive 带 stop_running 危险语义、unarchive 轻量恢复，分开触发更精准；合并破坏会话历史+权限契约，收益仅 -1 工具 | 不做 |
| `use_workspace` 改名 `register_workspace` | 描述首词已是 Register；改名收益小、破坏面大 | 不做 |
| watch 输出 `sessions` 改名 `watched` | PTC 消费契约；已改补 description 消歧（非破坏） | 不做 |
| 4 个 list_* 合并为 kind 参数 | 各自触发语境差异大，合并增加模型理解成本 | 不做 |
| 新增 `DEVLEAD_SESSION_AMBIGUOUS` 错误码（command 现把 INVALID_INPUT 整体当歧义） | 错误码联合新增成员，所有穷尽映射点需同步；0.x 可接受但应随 minor | 暂缓，随下个 minor |
| 加宽 report id 的 32 位 FNV 哈希 | id 是 durable 记录契约，改算法会孤立存量记录、冻结 replay | 不做；已在 docstring 写明碰撞容忍度，须随记录版本变更 |

### 12.4 未实施项与理由（非破坏，但本轮不做）

- **index.ts 拆分**（核心审计 P1）：冷重建机器（~400 行）与全局单活准入（~350 行）可抽
  `RehydrationCoordinator` / `ActiveAdmission` 两个深模块。属纯内部重构、公开 API 不变，但改动面大、
  需独立一轮充分验证；本轮聚焦正确性与工具面，**建议单独一轮**实施。
- **listSessions 两遍持久化 listing**（核心审计 P1，性能）：`collectSessionIds` 与 `sessionRankFacts`
  各列一遍语料。可复用同一批 header，但需重构 views 数据流并重验 fake 计数；listing 已被
  `maxListedSessions` 约束，非正确性问题，留待性能轮。
- **report()/persistReport() 完全合并**：本轮已抽共享 `reportRuntime` 守卫（统一 archived 检查），
  但两方法返回契约不同（同步队列决策 vs 已 flush 回执），完全合并会模糊语义，保留双方法。
- **`deliverNow` 公开方法**：仅测试调用，但它是合法的按需投递 seam（idle 钩子之外的显式入口），
  删除属破坏 hub 表面且无收益，保留。
- **`storageDomain as never` 类型洞**：与 outbox.ts 的 duck-typed 可选能力姿态一致；补 module
  augmentation 可能与 Host 自身 storage-domain 类型冲突，维持现状。
- **client-ui 视觉验收**：report 中性色、ring fallback 几何等仍需按 [UI-VERIFICATION](UI-VERIFICATION.md)
  在隔离 profile 人工视觉验收（单测只钉类名/CSS 文本）；本轮未启动浏览器，沿用上一轮"代码级判定 +
  待人工视觉复核"口径。

### 12.5 本轮提交（本地，未推送）

`44753c4` 之上 8 个提交：`4473b32` fix(tool) 描述残句+digest 限额披露；`e53d104` feat(tool)
default 注解+只读并发+kind 单一来源；`cc1a23b` refactor(tool) 描述去重；`e5f02fd`
fix(command,protocol) 标签折叠/引号诊断/drift；`10681d7` fix(devlead) 4 个 P0；`5956095`
fix(client-ui) 中性色/唤醒文案/竞态/缓存；`af7901c` docs 一致性；`2c84ee3` refactor(devlead)
normalize 共享+report 守卫。**不 push、不打 tag、不发布**（遵守发布纪律）。

## 13. DeepSeek v4.1 Flash 独立二审（2026-11-19）

本轮是换模型后的**独立二审**：由 DeepSeek v4.1 Flash 路由（本机唯一注册的 DeepSeek 模型；
Max 路由未注册）在 HEAD `2dfd5cd`、版本 `0.3.0-rc.1` 上重新审计 6 个包、脚本、文档与真实
DSH 运行行为，不以 §12 的结论为前提。审计先只读进行，再按包边界拆分修复；未改版本、未打
tag、未执行任何 stage/approve/publish/GitHub Release 动作。

### 13.1 结论摘要

- 找到并修复 **1 个高严重度授权缺陷**：`subagent_fork` 会逐字继承父会话已完成 turn 的日志，
  其中包含 `plugin:devlead/mode` / `watch` / `reset` 记录。三个 projection 原先忽略
  `init(header, inheritedEventCount)` 的继承前缀长度，导致 forked subagent 继承 DevLead
  模式、watch 集与全部 `devlead_*` 工具；准入扫描又跳过 `origin: 'subagent'`，形成不可见的
  第二个 lead。修复为三个 unit 都记录并跳过 `event.seq < inheritedEventCount` 的继承事件
  （`stateVersion` 3/2/2），并在 `isEnabled` / `setEnabled` / hub 索引处增加 subagent 防线。
- 修复 **2 个 P1 核心可靠性问题**：准入扫描在持久语料 listing 失败、或 cache 明确标为 active
  的日志读取失败时原先 best-effort 放行（可能产生第二个 active lead），现在严格模式 fail
  closed；interrupt 后 inbox 恢复失败原先会丢掉替换 prompt 并回滚 watch，现在降级为 warning
  并继续投递替换 prompt。
- 修复 **4 个 P2 核心问题**：outbox 7 天保留只在 replay 触发时执行（冷 lead 持续 report 可
  无限增长）；冻结 fold 的 `/devlead off` 恢复不丢弃 outbox 行；attach-only lead 被释放后
  hub 反向索引残留；storageDomain 晚挂载与 disposal 竞态泄漏 domain。
- 修复 **2 个 P1 工具面问题**：human-directed turn 判定会被 `time-context` /
  `agent-instructions` / `working-directory` 等注入消息打断，导致人类在场的
  `ask_user_question` 被错误转发；未声明参数（如 `promt`、`stopRunning`）被静默丢弃，可能
  创建空 Session、归档但不停止工作、或丢弃排队输入。
- 修复 **4 个 UI/协议问题**：DevLeadBar 不显示 completed 通知的 assistant 摘要（与 README
  不符）；`DEVLEAD_ALREADY_ACTIVE` 的占用者标题未折叠为单行且浏览器解析可被标题中的指令
  文本误导；DevLeadBar 对 wire drift 的 `sessions`/`notifications` 无防御；`excerptLine`
  未剥离 C0/C1 控制字符（ANSI/OSC 注入面）。
- 打包/文档：6 个发布包补齐 LICENSE 文本；根 `packageManager` 固定 pnpm 12.16.1；删除
  pnpm 12 已忽略的 `.npmrc` 安装键；修正 COMPATIBILITY 对根 `engines.dsh` 的错误描述与
  5 处 live 工具数（13 → 14）。

### 13.2 修复项

| ID | 严重度 | 问题 | 处置 |
| --- | --- | --- | --- |
| SEC-1 | 高 | fork 子会话继承 DevLead mode/watch/工具面，且准入扫描跳过 subagent | 三个 projection 记录 `inheritedEventCount` 并跳过继承前缀；`stateVersion` 3/2/2；`isEnabled`/`setEnabled`/hub `syncSession` 拒绝 subagent；新增 fold 与 service 回归测试 |
| CORE-1 | P1 | 持久语料 listing / cache-active 日志读取失败时准入放行 | `scanActiveSessions(..., strict)`；`blockingOccupant` fail closed 为 `DEVLEAD_SESSION_UNAVAILABLE`；测试覆盖两种失败 |
| CORE-2 | P1 | interrupt 后 `restoreInputs` 抛错会跳过 `followup` 并回滚 watch | restore 降级为 warning，替换 prompt 继续投递；新增 prepend 失败测试 |
| CORE-3 | P2 | outbox retention 只在 open/replay 时执行 | report 写入路径增加 1 小时节流 prune；新增过期行清理测试 |
| CORE-4 | P2 | 冻结 fold 的 `setEnabled(false)` 不丢弃该 lead 的 outbox 行 | 抽出 `discardLeadReportState`，reset 与 frozen-off 共用；新增测试 |
| CORE-5 | P2 | attach-only lead 释放后 hub watch 索引残留 | hub 新增无 Agent 的 `syncSession` 对账；新增 attach-only 释放测试 |
| CORE-6 | P2 | 晚挂载 storageDomain 与 disposal 竞态泄漏 handle | open 前后检查 `disposed` 并关闭竞态 handle；disposer 等待 `outboxOpening`；新增 deferred-open 测试 |
| SEC-3 | P2 | tombstone 的 ignored holder 仍留在 hub 索引，可继续 supervise/report | `rememberIgnored` 调用 `hub.forgetLead`；release 失败时重新墓碑；新增非归档 tombstone 测试 |
| TOOL-1 | P1 | human-directed 判定被注入 context 打断，人类在场的问题被错误转发 | 识别 `user`/`user-question-reply`/`user-approval`；跳过已知 context kind 与 context form；未知 kind fail closed |
| TOOL-2 | P1 | 未声明参数被静默忽略 | 15 个工具统一 `assertKnownArguments`；未知 key 返回 `DEVLEAD_INVALID_INPUT` 且不调用 core |
| TOOL-3/4/5 | P2 | `queuedInputs`/`resumed`/`watch=false`/`durable:false` 文案与实现不符 | 工具描述与输出字段描述同步实现 |
| UI-1 | P2 | DevLeadBar 不渲染 completed 通知的 assistant 摘要 | `notificationSummary` 增加 sanitized `summary`；无 error 时用中性 detail 渲染 |
| UI-2 | P2 | `/devlead status` 文档承诺 cold 行的 latest turn，但列表不读 cold 日志 | 文档改为 “latest turn when known”；详情仍由 `devlead_get_session` 提供 |
| UI-3 | P2 | 占用者标题可多行/超长，且客户端按 `indexOf` 解析可被标题欺骗 | `activeSessionLabel` 走 protocol `sessionRefLabel`；客户端改 `lastIndexOf` + 完整 tail 校验 |
| UI-4 | P2 | DevLeadBar 对 wire drift 的集合无防御 | `Array.isArray` 降级 + `latestNotification`/`latestReport`/`summarizeWatched` 容忍 undefined |
| SEC-5 | P2 | `excerptLine` 保留 ANSI/OSC 控制字符 | 折叠空白后剥离 C0/C1；新增 ESC/BEL/CSI 测试 |
| PKG-1 | P2 | `.npmrc` 的 pnpm 安装键在 pnpm 12 下不生效 | 删除死键并记录原因，避免继续误导 |
| PKG-3 | P2 | 5 处 live 文档仍写 13 个主工具 | 改为 14（历史 release 文档保留 13） |
| PKG-4 | P2 | `corepack enable` 不能固定 12.16.1 | 根 `packageManager: pnpm@12.16.1`，并由 check-packages 校验 |
| PKG-5 | P2 | 6 个发布包 tarball 不含 LICENSE 文本 | 每包复制根 LICENSE 并加入 `files`；check-packages 校验字节一致 |
| PKG-6 | P2 | COMPATIBILITY 误称根 package.json 声明 `engines.dsh` | 改为只有 6 个发布包声明 |

### 13.3 未改项与理由

- **question report 无每轮上限**（安全审计 SEC-2）：当前设计刻意让 question 豁免普通 report
  的每轮 4 条预算，以保证受关注子会话的提问总能到达 lead；digest 仍有 64 条上限，子会话被
  明确要求提问后结束 turn。给 question 增加独立上限属于产品语义收紧，留待下个 minor 评估，
  本轮不引入。
- **准入扫描的 64 条 unknown 读上限**（SEC-3）：cache 缺失或旧行不可分类时，扫描仍有界；
  strict 模式只覆盖“可验证但失败”的路径。改成对 capped 也 fail closed 会让没有 projection
  cache 的大历史 Host 无法开启 DevLead，属于可用性与严格性的取舍，保留 warning 并记录。
- **裸 `source.kind === 'user'` 仍被当作人类在场**（SEC-4）：DSH 的 source 是 merge-extensible
  开放集，某些插件（timeline、claude-code-mods、headless/SDK）也会以 `user` 注入内容。本轮
  已跳过已知 context kind/form 并让未知 kind fail closed；默认 Web 组合下 `user` 仍代表人类
  入口。要完全消除该假设需要 Host 提供不可伪造的 client/human 标记，属于 DSH 侧改动。
- **Host 级破坏性工具只靠 mode + policy 约束**（SEC-6）：`archive(stop_running)`、
  `remove_workspace`、`use_workspace(create)`、`prompt_session(interrupt)` 没有逐次审批。
  这是 DevLead 的既有设计（人类显式开启模式即授予该委托面），本轮不改；若未来要更强隔离，
  建议在 `tools/pre-execute` 加 Host approval，或记录 lead 创建的 Session/Workspace 并限制
  关闭范围。该改动会改变交互，需人类产品决策。
- **lead 日志被删除后的 ghost supervisor**（SEC-7）：hub 为支持冷 lead 故意不在
  `agent/disposed` 时移除索引；若持久日志被外部删除且同一进程内没有重建事件，索引可能残留。
  未找到可靠的 “Session 被删除” 信号，本轮不猜；重启后持久扫描自然清除。
- **`/devlead` status 的重复全局扫描**（UI-5）：mutation 结果也会调用 `archivedOccupants`，
  在无 cache 的 Host 上多做一次最多 64 条日志读取。它只影响人类显式命令的延迟，且 mutation
  结果需要展示 archived holder 诊断；本轮保留。
- **`listSessions` 两遍持久化 listing**、**index.ts 拆分**：§12.4 已记录，仍属独立性能/重构
  轮，不在本轮扩大改动面。
- **`subagent_fork` 的 projection 继承语义**：本轮只让 DevLead 自己的三个 unit 忽略继承前缀；
  其他插件是否应继承父状态不在本仓库边界内。

### 13.4 验证矩阵

- `pnpm install --frozen-lockfile`：通过（pnpm 12.16.1；新 lockfile 记录 packageManager）。
- `pnpm verify`：通过；typecheck + **26 文件 / 868 tests** + 6 个构建产物（基线 845，净增 23）。
- `pnpm check:packages`：`OK (6 packages)`（新增 LICENSE / packageManager 断言）。
- `pnpm e2e`（本机安装版 DSH **0.2.2-rc.5**，真实 Web）：
  - `--flow patch`：phase 1 27/27 + 1b 12/12 + 2 23/23 + 3 88/88 = **150/150**；
  - `--flow installed`：同 **150/150**（3 条正向 model 检查因无 provider 凭据 SKIP）。
- 隔离 profile 浏览器验收（临时 `DSH_HOME`，不碰 desktop profile）：
  - 关闭态只有 composer 工具栏的 DevLead 图标 + 文本开关；
  - 开启后 `DevLeadBar` 出现，开关保持原位并变 pressed；
  - 真实创建并关注一个子 Session、子 turn 完成后，bar 显示
    `已关注 1 个会话 • 运行中 0 • <id> 第 1 轮 完成 UI summary check complete`，
    证明 UI-1 的 assistant 摘要渲染生效；
  - 侧栏 active lead 行有强调色 `::after` ring、无行尾图标；watched 行有弱化准星；
  - 点回开关后 `aria-pressed=false` 且 `DevLeadBar` 消失；临时 home 已删除。
- 审计边界：未修改 `@deepseek-ai/*` 源码、未解压 app.asar、未触碰其他仓库或 release Session。
