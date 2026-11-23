# DevLead 项目看板（schema v1）

项目看板为 DevLead 提供跨 Session 的持久项目状态。**唯一事实源是 `boardPath` 指向的 JSON
文件**；人类/浏览器只读，只有启用 DevLead 模式的 lead AI 可以通过 `devlead_board_update`
写入。Step A 实现 Host 数据层、AI 工具、动态摘要和浏览器 global；Step B 实现右侧栏只读 UI。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 loader row `devlead` 的 `config`。`boardPath` trim 后
为空白即功能禁用；非空必须是绝对路径，相对路径直接拒绝，不再按 cwd resolve。路径只来自部署
配置；两个 AI 工具都没有、也不接受 board 文件路径参数。不要把某个开发者的本机绝对路径提交到
本仓库。

```yaml
- id: devlead
  name: '@yankeguo/dsh-devlead'
  config:
    # 其余 devlead config 按部署需要保留；DSH 整体替换一行的 config。
    boardPath: /path/to/workbox/.dsh/devlead/board.json
```

配置 board 后，`DevLeadBoardStore.start()` 先以 `mkdir(dirname, {recursive:true, mode:0o700})`
幂等预创建父目录（不修改已有目录权限），再启动读取/监听；预创建失败以 `BOARD_IO_ERROR` reject。
这保证浏览器 chokidar 首开时父目录已存在，Host 首次写入能触发 `add` 事件。`update()` 仍先完成
逻辑预检，再执行自己的 mkdir，因此失败预检不会由 update 新建目录。文件以 `0600` 原子替换。
是否把该文件或 `.dsh/` 加入 workbox 仓库的 `.gitignore` 由用户/仓库所有者决定；插件不修改
`.gitignore`，也不要求看板进入 Git。

## 文件 schema v1

所有对象均 strict：未知字段、重复 project id、重复 workspace.path、重复 blocker/task id、
错误枚举、非绝对 workspace 路径和非法时间都会拒绝。时间只接受 ISO-8601 UTC `Z` 形式，带
offset 的时间拒绝。`updatedBy` 是最后写入的 lead Session id/title；写入时 title 先 trim，
空白回退为 `DevLead`，再截到最多 200 个 UTF-16 code units。

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "updatedAt": "2026-11-23T06:20:00.000Z",
  "updatedBy": { "sessionId": "session-...", "title": "DevLead" },
  "projects": [{
    "id": "example-project",
    "workspace": { "path": "/path/to/workbox", "title": "example-project" },
    "status": "active",
    "priority": "high",
    "goal": "目标",
    "focus": "当前焦点",
    "next": "下一步",
    "blockers": [{ "id": "b1", "text": "等待输入", "since": "2026-11-23T06:20:00.000Z", "sessionId": "session-..." }],
    "tasks": [{ "id": "t1", "title": "任务", "status": "doing", "ownerSessionId": "session-...", "updatedAt": "2026-11-23T06:20:00.000Z" }],
    "updatedAt": "2026-11-23T06:20:00.000Z"
  }]
}
```

- `status`: `active | blocked | paused | done`；创建默认 `active`。
- `priority`: `low | medium | high`；创建默认 `medium`。
- task `status`: `todo | doing | blocked | done`；创建默认 `todo`。
- `goal` / `focus` / `next` 创建默认为空字符串；blocker 的 `sessionId` 和 task 的
  `ownerSessionId` 可省略。
- 限制：文件最大 **256 KiB**，最多 **50 projects**，每项目最多 **200 tasks**、**50 blockers**；
  id 128、project/updatedBy title 200、path 4096、长自由文本 4000 个 UTF-16 code units。
- 每次实际写入 `revision + 1` 并更新 `updatedAt` / `updatedBy`；无变化 patch 不写文件、不增加
  revision。auto 字段（running、lastActivity、lastError 等）**不落盘**，留给 Step B 或读取侧
  从现有 sessions/workspaces 推导。

## 数据层与故障语义

Host 通过 `ctx.devLead.board` 暴露：

- `path` / `enabled`：部署状态；
- `read(filter?)`：返回 `{ revision, updatedAt, projects, truncated? }`；
- `update(patch, expectedRevision?, signal?)`：返回 `{ revision, updatedAt, project, changed }`，
  其中 project 省略 tasks；
- `summary()`：从最后合法内存缓存同步渲染摘要。

`ctx.devLead.updateBoard(agent, patch, expectedRevision?, signal?)` 额外补上 lead 身份。
`update()` 在未配置 board 或 `expectedRevision` 不是非负安全整数时返回 rejected Promise；
revision 不一致返回 `BOARD_REVISION_CONFLICT`。

写入使用 Host 内单条 promise 链，再在 `withFileLock` 跨进程锁内 fresh read、read-modify-write，
以磁盘 revision 做 CAS，最后 `writeFileAtomic` 替换。`refresh(true)` 会先等待已有 in-flight
load，再自己执行一次 fresh read，绝不把另一个调用尚未完成的快照当作锁内真值。外部非法 JSON、
schema 错误、未知字段或超限文件会产生带 RFC 6901 JSON pointer 的结构化错误，同时保留最后合法
缓存供摘要使用；读取和更新都报错，**绝不以缓存覆盖坏文件**。

读路径使用内存缓存、stat 指纹和父目录 `fs.watch` 失效/刷新。每次 load 最多尝试 4 次，比较读取
前后的 `mtimeMs/size/ino` 指纹，并核对实际 UTF-8 字节数；只有稳定快照才进入缓存。文件持续变化
时返回可重试的 `BOARD_IO_ERROR`。watcher 出错后，在下一次成功 load 时 rearm。

文件不存在为 `BOARD_NOT_FOUND`，未配置为 `BOARD_DISABLED`。start 的父目录预创建失败、读取
故障以及整个写周期中已知的 filesystem 错误、锁超时和 `FileLockError` 都映射为
`BOARD_IO_ERROR`，领域错误保持原错误码；锁超时文案提示当前 writer 结束后 retry。原子替换不等于
fsync 或掉电持久性保证；尤其原子替换后的 `stat` 失败也会报 `BOARD_IO_ERROR`，但本次结果可能
已经提交，重试前应先重新读取磁盘状态。

## AI 工具

两个工具均带 `when: ({agent}) => ctx.devLead.isEnabled(agent)`，并与其他工具共用
`assertKnownArguments`。

### `devlead_board_read`

参数：`project?`、`include_tasks?`、`limit?`。project 支持精确 id、workspace title 或绝对
workspace path；title 歧义返回 `BOARD_PROJECT_AMBIGUOUS`。省略 project 返回有界项目列表，
默认不含 tasks，`limit` 最大 50，超出列表上限时 `truncated:true`。单项目默认含 tasks，但最多
返回 50 条，超出时同样 `truncated:true`。结果为 `{ revision, updatedAt, projects, truncated? }`。

### `devlead_board_update`

参数：`project`、`expected_revision?`、`create?`、`set?`、`blockers?`、`tasks?`。
创建必须显式 `create:true` 并提供 `set.workspace.path`；此时 `project` 是新 id。

- `set`: `status` / `priority` / `goal` / `focus` / `next` / `workspace.path` /
  `workspace.title`。
- `blockers`: `clear` → `remove` → `add`；add 项为 `{id,text,session_id?}`，同 id 替换时保留
  原 `since`，省略 `session_id` 时保留原值；重复 add 若完全无变化，不写文件也不 bump revision。
- `tasks`: `remove` → `upsert`；upsert 项为
  `{id,title?,status?,owner_session_id?}`，新 task 必须有非空 title。
- 返回 `{revision,updatedAt,project,changed[]}`，只返回省略 tasks 的目标项目，不回传整个 board；
  工具层还会防御性剥离 tasks，避免旧 core 或异常结果泄漏完整任务清单。

稳定错误码包括 `BOARD_DISABLED`、`BOARD_NOT_FOUND`、`BOARD_INVALID`、
`BOARD_PROJECT_NOT_FOUND`、`BOARD_PROJECT_AMBIGUOUS`、`BOARD_REVISION_CONFLICT`、
`BOARD_LIMIT_EXCEEDED`、`BOARD_IO_ERROR`。这些领域错误（包括 title 歧义和 I/O 故障）在工具层
映射为带相同 code 的 `HarnessError`。完成态 `presentResult` 只显示摘要，即使项目带有 200 个
tasks 也不把整个项目重复画到卡片上。

## 每轮动态摘要

`devlead:board-summary` 通过 `ctx.systemPrompt.context()` 注入 user-role runtime snapshot，
而不是每轮变化的 system section。仅 enabled lead 且缓存中有项目时非空；禁用、未加载或空
projects 返回空串。首行格式：

```text
DevLead board r<rev> <updatedAt>; projects N: active a, blocked b, paused c, done d
```

随后每项目一行，含 id/title、status/priority、截断 focus 和 blocker 数量。project id、
workspace.title 与 focus 中的控制/格式字符先替换并折叠为单行空白，防止注入额外摘要行；整体
不超过 1536 UTF-8 bytes。相同文本由 DSH 复用，board 提交后的新 revision 在下一次上下文重建
生效。

## Step B 浏览器契约

board 启用时，client-ui 的 Host 入口在每次 `webserver/index-inject` 中注入：

```ts
window.__DSH_DEVLEAD_BOARD__ = {
  boardPath: '/path/to/workbox/.dsh/devlead/board.json',
  schemaVersion: 1,
  pathPlatform: 'posix', // Windows Host 为 'win32'
}
```

禁用时 global 不注入。Step B 的 `dsh.client.inject` 另声明
`@deepseek-ai/dsh-api-workspace-files`、`@deepseek-ai/dsh-api-workspace-controller` 与
`@deepseek-ai/dsh-client-ui-sidebar-right`，但不新增 board RPC，也不向浏览器暴露任何写能力。
client 按官方右栏插件契约静态组合 `remote.workspaceFiles`、`sidebarRight`、`sidebarRightTabs`
与 `workspaces`；global 是否存在只控制下列 UI 注册，未配置时不显示任何看板入口：

- tab definition：`kind: 'devlead-board'`，`id: '@yankeguo/dsh-client-ui-devlead/board'`；标准
  guide entry 与会话头 `conversation.session.header.utilities` 按钮通过
  `sidebarRight.openTab(kind)` 打开。body slot 是 `sidebar.right.pane.tab`，其 `key` 是 definition
  的 **id**（不是 kind）。
- `useBoardFile`：以当前 tab 的 SessionId 调 `stat` + `readBytes(..., {})`，并直接消费
  `changes`。首读与 ready 后重读关闭订阅竞态，change 经 120ms debounce 重读；卸载 abort 读取/
  watch 并 `dispose()` stream。旧 request generation 不能覆盖新结果。watch 断开单独显示警告，
  不再把旧内容标为“正常”；手动刷新同时重读并重建 watch。
- 浏览器自己的 strict schema v1 解码器（不引入 Host/Node 模块）拒绝坏 UTF-8、坏 JSON、未知
  字段、重复 id、错误枚举和超限文件。绝对路径按 Host 显式发布的 `pathPlatform` 选择
  `node:path.posix` 或 `node:path.win32` 语义，不从路径字符串或浏览器 OS 猜测。文件不存在是
  「还没有看板数据」；Remote 错误是读取错误；JSON/schema 错误是
  解析错误，显示最后成功时间与重试，不保留旧项目卡片。
- 项目按 blocked / active / paused / done 分组，同组按 high / medium / low、updatedAt 倒序、id
  稳定排序；卡片展示 workspace、focus/next/blockers 和原生 `<details>` 任务清单。顶部展示
  revision、updatedAt 相对时间与读取状态。
- 「未在看板中的项目」折叠区只连接 Host 的 `useWorkspaces` / `useSessions` 投影，按 workspace
  path 过滤（POSIX 尾斜杠、Windows 分隔符/大小写做语法规范化），显示名称、path、会话数和这些
  Sessions 的最新 updatedAt；Session 清单 pending 时显示读取中，不谎报无活动。symlink/realpath
  别名仍需 Step C 由 Host 权威解析，浏览器不伪造 canonicalization。清单 pending/error 也明确标注。

所有样式沿用 `ensureStyleTag` 与 `--dsw-*` token，文案在 `devlead` namespace 的 zh/en 词典。
纯函数、Remote hook、注册和 `react-test-renderer` 组件测试覆盖上述状态与排序契约。Step C 可在
不修改文件所有权的前提下复用 `DevLeadBoardPanelView` 做全页视图，或另加 Session 跳转/自动状态合并。
