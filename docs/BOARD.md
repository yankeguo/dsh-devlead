# DevLead 项目看板（schema v1）

项目看板为 DevLead 提供跨 Session 的持久项目状态。**唯一事实源是 `boardPath` 指向的 JSON
文件**；人类/浏览器只读，只有启用 DevLead 模式的 lead AI 可以通过 `devlead_board_update`
写入。Step A 实现 Host 数据层、AI 工具、动态摘要和浏览器 global；右侧栏 UI 属于 Step B。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 loader row `devlead` 的 `config`。`boardPath` 默认为
空字符串，即功能禁用。路径只来自部署配置，启动时解析为绝对路径；两个 AI 工具都没有、也
不接受 board 文件路径参数。不要把某个开发者的本机绝对路径提交到本仓库。

```yaml
- id: devlead
  name: '@yankeguo/dsh-devlead'
  config:
    # 其余 devlead config 按部署需要保留；DSH 整体替换一行的 config。
    boardPath: /path/to/workbox/.dsh/devlead/board.json
```

第一次成功写入会递归创建父目录（`0700`），文件以 `0600` 原子替换。是否把该文件或
`.dsh/` 加入 workbox 仓库的 `.gitignore` 由用户/仓库所有者决定；插件不修改 `.gitignore`，
也不要求看板进入 Git。

## 文件 schema v1

所有对象均 strict：未知字段、重复 project/blocker/task id、错误枚举、非绝对 workspace
路径和非法时间都会拒绝。时间为 ISO-8601 UTC 字符串；`updatedBy` 是最后写入的 lead
Session id/title。

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
  id 128、title 200、path 4096、长自由文本 4000 个 UTF-16 code units。
- 每次实际写入 `revision + 1` 并更新 `updatedAt` / `updatedBy`；无变化 patch 不写文件、不增加
  revision。auto 字段（running、lastActivity、lastError 等）**不落盘**，留给 Step B 或读取侧
  从现有 sessions/workspaces 推导。

## 数据层与故障语义

Host 通过 `ctx.devLead.board` 暴露：

- `path` / `enabled`：部署状态；
- `read(filter?)`：返回 `{ revision, updatedAt, projects, truncated? }`；
- `update(patch, expectedRevision?, signal?)`：返回 `{ revision, updatedAt, project, changed }`；
- `summary()`：从最后合法内存缓存同步渲染摘要。

`ctx.devLead.updateBoard(agent, patch, expectedRevision?, signal?)` 额外补上 lead 身份。
写入使用 Host 内单条 promise 链，再在 `withFileLock` 跨进程锁内重新读取、read-modify-write，
最后 `writeFileAtomic` 替换。`expectedRevision` 不一致返回 `BOARD_REVISION_CONFLICT`。

读路径使用内存缓存、stat 指纹和父目录 `fs.watch` 失效/刷新。外部非法 JSON、schema 错误、
未知字段或超限文件会产生带 RFC 6901 JSON pointer 的结构化错误，同时保留最后合法缓存供摘要
使用；读取和更新都报错，**绝不以缓存覆盖坏文件**。文件不存在为 `BOARD_NOT_FOUND`，未配置为
`BOARD_DISABLED`，其它 I/O 故障为 `BOARD_IO_ERROR`。

## AI 工具

两个工具均带 `when: ({agent}) => ctx.devLead.isEnabled(agent)`，并与其他工具共用
`assertKnownArguments`。

### `devlead_board_read`

参数：`project?`、`include_tasks?`、`limit?`。project 支持精确 id、workspace title 或绝对
workspace path；title 歧义返回 `BOARD_PROJECT_AMBIGUOUS`。省略 project 返回有界项目列表，
默认不含 tasks，limit 最大 50；单项目默认含 tasks。结果为
`{ revision, updatedAt, projects, truncated? }`。

### `devlead_board_update`

参数：`project`、`expected_revision?`、`create?`、`set?`、`blockers?`、`tasks?`。
创建必须显式 `create:true` 并提供 `set.workspace.path`；此时 `project` 是新 id。

- `set`: `status` / `priority` / `goal` / `focus` / `next` / `workspace.path` /
  `workspace.title`。
- `blockers`: `clear` → `remove` → `add`；add 项为 `{id,text,session_id?}`，同 id 替换时保留
  原 `since`。
- `tasks`: `remove` → `upsert`；upsert 项为
  `{id,title?,status?,owner_session_id?}`，新 task 必须有非空 title。
- 返回 `{revision,updatedAt,project,changed[]}`，只返回目标项目，不回传整个 board。

稳定错误码包括 `BOARD_DISABLED`、`BOARD_NOT_FOUND`、`BOARD_INVALID`、
`BOARD_PROJECT_NOT_FOUND`、`BOARD_PROJECT_AMBIGUOUS`、`BOARD_REVISION_CONFLICT`、
`BOARD_LIMIT_EXCEEDED`、`BOARD_IO_ERROR`。完成态 `presentResult` 只显示摘要，即使项目带有
200 个 tasks 也不把整个项目重复画到卡片上。

## 每轮动态摘要

`devlead:board-summary` 通过 `ctx.systemPrompt.context()` 注入 user-role runtime snapshot，
而不是每轮变化的 system section。仅 enabled lead 且缓存中有项目时非空；禁用、未加载或空
projects 返回空串。首行格式：

```text
DevLead board r<rev> <updatedAt>; projects N: active a, blocked b, paused c, done d
```

随后每项目一行，含 id/title、status/priority、截断 focus 和 blocker 数量，整体不超过
1536 UTF-8 bytes。相同文本由 DSH 复用，board 提交后的新 revision 在下一次上下文重建生效。

## Step B 浏览器契约

board 启用时，client-ui 的 Host 入口在每次 `webserver/index-inject` 中注入：

```ts
window.__DSH_DEVLEAD_BOARD__ = {
  boardPath: '/path/to/workbox/.dsh/devlead/board.json',
  schemaVersion: 1,
}
```

禁用时 global 不注入。Step B 应在 `dsh.client.inject` 增加
`@deepseek-ai/dsh-api-workspace-files` 与 `@deepseek-ai/dsh-client-ui-sidebar-right`，用现有
`remote.workspaceFiles.readBytes/stat/changes` 对该绝对路径只读，再注册
`sidebar.right.pane.tab`。不要新增 board RPC，不要把写能力暴露到浏览器。本步没有改变现有
client bundle 的 UI 行为。
