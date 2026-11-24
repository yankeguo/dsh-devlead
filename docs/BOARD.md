# DevLead 项目看板（schema v1）

项目看板为 DevLead 提供跨 Session 的持久项目状态。**看板默认启用、无需任何配置**：唯一事实源
是当前 active lead 的看板文件，默认由该 Session 原始 workspace 根派生
`<cwd>/.dsh/devlead/board.json`（`boardPath` 配置项只是可选的绝对路径 override）。人类/浏览器
只读，只有启用 DevLead 模式的 lead AI 可以通过
`devlead_board_update` 写入看板、通过 `devlead_board_note_write` 维护项目 notes 索引；note 正文由 lead 使用
DSH 原生 read/write/edit 编辑。Step A 实现 Host
数据层、AI 工具、动态摘要和浏览器 global；Step B 实现右侧栏只读 UI。动态默认路径、lead 生命周期、
lead-only 客户端入口与 notes reader 以本页当前契约为准。

## 默认启用、路径与生命周期

- **默认启用**：Host 在唯一的 active lead Session 上解析看板路径：
  `<SessionHeader.cwd>/.dsh/devlead/board.json`。`SessionHeader.cwd` 是 Session **创建时的原始
  workspace 根**，不是某次 turn 的 effective/worktree cwd；worktree 隔离的 lead 仍把看板放在
  项目根，而不是 `.agents/worktrees/...` 检出里。
- **派生路径要求 workspace 根仍然存在**：没有 override 时，Host 在派生
  `<cwd>/.dsh/devlead/board.json` 前先确认该 `cwd` 仍是**已存在的目录**。不存在（cold lead 记录的
  workspace 被删除/移走/变成普通文件，或无法 `stat`）时看板进入 disabled 状态，新增 reason
  `missing-workspace`（`ctx.devLead.boardDisabledReason` 可读），只记录一条 warning；
  **不会 `mkdir` 重建 workspace 根，也不会写入任何文件**，工具返回 `BOARD_DISABLED`、摘要为空、
  不注入浏览器 global。workspace 恢复后，下一次 lead 同步/切换会重新解析并重新启用看板。
  显式 `boardPath` override 不受此限制，保持既有预创建语义（见下）。
- **没有 lead 就看板禁用**：没有 active lead 时，或既未配置 `boardPath` override、lead 的
  header 又没有绝对 workspace 根时，工具返回 `BOARD_DISABLED`、动态摘要为空、浏览器 global 不注入、
  UI 不显示任何看板入口；不会伪造相对路径，也不会回退到插件安装目录。
- **单活即单 store**：DevLead 模式本来就是 Host 级单活（见 [DESIGN](DESIGN.md) §2），因此
  同一时刻最多只有一个看板 store 与一个目录 watcher。`/devlead off`、lead 切换到另一个
  Session、或 lead 的 workspace 根变化时，Host 先关闭旧 store（释放 watcher 与订阅），再
  切换到新路径；路径未变（例如同一 workspace 内换 lead）时复用同一个 store，不反复 churn。
  store 切换串行执行，读取不会看到半切换状态。
- **切换立即生效**：下一次 `devlead_board_read` / `devlead_board_update` 与浏览器面板读的是
  当前 active lead 的文件，绝不继续读旧 lead 的文件；旧文件里的数据不会迁移。

## 配置（可选 override）

默认零配置即可用。只有需要把看板放到固定位置时才在 profile 的 `cordis.patch.yml` 中覆盖
loader row `devlead` 的 `config.boardPath`；显式非空时它**优先于自动派生**。既有已配置
`boardPath` 的部署升级后行为不变（路径、权限、CAS 语义都不变）。`boardPath` trim 后为空白
表示“使用 active lead workspace 自动派生”，非空必须是绝对路径，相对路径直接拒绝，不按 cwd
resolve。路径只来自部署配置；两个 AI 工具都没有、也不接受 board 文件路径参数。不要把某个
开发者的本机绝对路径提交到本仓库。

```yaml
- id: devlead
  name: '@yankeguo/dsh-devlead'
  config:
    # 其余 devlead config 按部署需要保留；DSH 整体替换一行的 config。
    # 可选：显式固定看板路径；省略/空白则由 active lead 的 workspace 自动派生。
    boardPath: /path/to/workbox/.dsh/devlead/board.json
```

`boardPath` 的**最终组件不能是 symlink**：写入是把同目录临时文件原子 rename 到该路径，会替换
symlink 本身而不是它指向的目标文件，外部对目标的编辑因此不会被看板读到；目录链中的 symlink
可以正常工作（`mkdir`、`stat` 与目录 watch 都按解析后的目录进行）。插件不做 realpath
canonicalization。

看板路径解析完成后，`DevLeadBoardStore.start()` 先以
`mkdir(dirname, {recursive:true, mode:0o700})` 幂等预创建父目录（不修改已有目录权限），再启动
读取/监听。这保证浏览器 chokidar 首开时父目录已存在，Host 首次写入能触发 `add` 事件。该预创建
只发生在**显式 override** 或**已确认存在的派生 workspace 根**之上：派生路径的 workspace 根不存在
时不会进入 `start()`（见上文 `missing-workspace`）。
`update()` 仍先完成逻辑预检，再执行自己的 mkdir，因此失败预检不会由 update 新建目录。文件以
`0600` 原子替换。是否把 `.dsh/devlead/` 加入仓库的 `.gitignore` 由用户/仓库所有者决定；
插件不修改 `.gitignore`，也不要求看板进入 Git。

**start 失败不阻塞 DevLead（P2-2）**：父目录预创建或 `start()` 失败时，Host 只记录一条 warning
并把看板标记为 degraded；`DevLeadService`、`devlead_*` 工具、`/devlead` 命令与浏览器 UI 照常
加载。此时 board 相关工具与摘要按真实故障返回 `BOARD_IO_ERROR`（或保持空摘要），其余 DevLead
功能不受影响。下一次 lead 同步（同一 resolved 路径也会**按需重试** `start()`）或路径切换会再次
尝试 `start()`；重试仍失败时 `boardStartError` 保留最后一次真实故障。

## 文件 schema v1

所有对象均 strict：未知字段、重复 project id、重复 workspace.path、重复 blocker/task id、
错误枚举、非绝对 workspace 路径和非法时间都会拒绝。该 schema、limits 与重复规则只有一份实现：
`@yankeguo/dsh-devlead-protocol` 的 `createDevLeadBoardSchema(isAbsolutePath)`，Host 与浏览器
共用；Host 传入自己的 `node:path.isAbsolute`，浏览器按 Host 发布的 `pathPlatform` 传入
POSIX/Windows 谓词。同一协议包还导出默认路径段
（`DEVLEAD_BOARD_DIR_SEGMENTS = ['.dsh','devlead']`、`DEVLEAD_BOARD_FILE_NAME = 'board.json'`）
与读取上限 `DEVLEAD_BOARD_READ_MAX_BYTES`，Host 自动派生与浏览器 global 缺失时的派生共用这些
常量，不会各写一份。`packages/protocol/tests/board.spec.ts` 固化 accept/reject 矩阵，
`packages/devlead/tests/board.spec.ts` 与 `packages/client-ui/tests/board.spec.ts` 分别固定
两端消费面。时间只接受 ISO-8601 UTC `Z` 形式，带
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
  revision。auto 字段（running、lastActivity、lastError 等）**不落盘**，由读取侧从现有
  sessions/workspaces 推导。

## 数据层与故障语义

Host 通过 `ctx.devLead.board` 暴露**当前 active lead 的 store**（没有 lead，或既无 override 又无
绝对 workspace 根时是 disabled store）：

- `path` / `enabled`：当前 store 状态；无 lead/workspace 根时为 undefined / false；
- `read(filter?)`：返回 `{ revision, updatedAt, projects, truncated? }`；
- `update(patch, expectedRevision?, signal?)`：返回 `{ revision, updatedAt, project, changed }`，
  其中 project 省略 tasks；
- `summary()`：从最后合法内存缓存同步渲染摘要；禁用或空 projects 时为空串。

`ctx.devLead.boardLeadSessionId` / `boardPathOverride` / `boardStartError` /
`boardDisabledReason` 暴露当前 store 归属的 lead Session、路径是否来自 Config override、最近一次
start 失败（degraded 时非空），以及看板当前被禁用的原因（`no-workspace` /
`relative-workspace` / `invalid-override` / `missing-workspace`；有活动 store 时 undefined）。
`ctx.devLead.updateBoard(agent, patch, expectedRevision?, signal?)` 额外补上 lead 身份；调用者
必须是当前 active lead，否则 `BOARD_DISABLED`。`read()` / `update()` 在没有 board 或
`expectedRevision` 不是非负安全整数时返回 rejected Promise；revision 不一致返回
`BOARD_REVISION_CONFLICT`。

写入使用 Host 内单条 promise 链，再在 `withFileLock` 跨进程锁内 fresh read、read-modify-write，
以磁盘 revision 做 CAS，最后 `writeFileAtomic` 替换。`refresh(true)` 会先等待已有 in-flight
load，再自己执行一次 fresh read，绝不把另一个调用尚未完成的快照当作锁内真值。外部非法 JSON、
schema 错误、未知字段或超限文件会产生带 RFC 6901 JSON pointer 的结构化错误，同时保留最后合法
缓存供摘要使用；读取和更新都报错，**绝不以缓存覆盖坏文件**。

读路径使用内存缓存、stat 指纹和父目录 `fs.watch` 失效/刷新。每次 load 最多尝试 4 次，比较读取
前后的 `mtimeMs/size/ino` 指纹，并核对实际 UTF-8 字节数；只有稳定快照才进入缓存。文件持续变化
时返回可重试的 `BOARD_IO_ERROR`。watcher 出错后，在下一次成功 load 时 rearm。

文件不存在为 `BOARD_NOT_FOUND`；没有 active lead（或既无 override 又无绝对 workspace 根）、派生
路径的 workspace 根已不存在（`missing-workspace`），或调用者不是当前 active lead
时为 `BOARD_DISABLED`。start 的父目录预创建失败、读取故障以及整个写周期中已知的 filesystem
错误、锁超时和 `FileLockError` 都映射为 `BOARD_IO_ERROR`，领域错误保持原错误码；锁超时文案
提示当前 writer 结束后 retry。start 失败本身不会 reject 服务加载：它只产生
`boardStartError` 与 warning，之后对 board 的每次读取/写入按真实文件系统故障返回
`BOARD_IO_ERROR`，摘要保持空。原子替换不等于 fsync 或掉电持久性保证；尤其原子替换后的
`stat` 失败也会报 `BOARD_IO_ERROR`，但本次结果可能已经提交，重试前应先重新读取磁盘状态。

## 项目 Markdown notes（schema v1）

每个看板可以带一组项目 notes。它们与 `board.json` 同生命周期、同 active lead 所有权，但使用独立文件；
**不修改 board.json 的 schema、revision 或内容，也不新增配置项、Host global 或 Remote API**。notes 根目录
只由当前已解析的 `boardPath` 派生：

```text
<dirname(boardPath)>/
├── board.json                 # 原有看板，完全不变
└── notes/
    ├── index.json            # schema v1；已提交 metadata 的唯一事实源
    └── <sanitized-project>/
        └── <note-id>.md      # UTF-8 Markdown 正文
```

只有当前 active lead AI 可以通过 notes 工具创建/改元数据/删除索引，并通过 DSH 原生文件工具编辑返回的
Markdown 绝对路径；人类与浏览器始终只读。没有 active lead/board path、调用者不是当前 active lead 时，
工具读写均报 `BOARD_DISABLED`。project 必须已经存在于 board，不能用 notes 创建一个不在看板里的项目。
agent 不得手改 `notes/index.json`。

### 路径、id 与严格 index schema

`DevLeadBoardNotesStore` 固定 `path = dirname(boardPath)/notes`、`indexPath = <path>/index.json`，调用者
不能传入 root、index 或正文路径。project directory 由 Host 从原始 board project id 生成：NFKD/lowercase
后保留安全 ASCII 段，截断的可读 base 加 project id 的 SHA-256 短 digest，避免不同 id 清理成同名目录；
极端短 digest 冲突使用完整 hash。已有项目的 directory 永久沿用 index 中的值。create 省略 note id 时由
Host 生成 UUID；调用者提供的 id 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`，不能是路径或 traversal。
为保证 macOS/Windows 的大小写不敏感文件系统与跨平台移动安全，项目内 note id 按 `id.toLowerCase()` 判重，
全局 note path 按 `path.toLowerCase()` 判重；`CaseNote` 与 `casenote` 是同一个冲突身份，不能写入两份正文。
note id 与 project directory 还拒绝 Windows 设备保留名 `CON/PRN/AUX/NUL/COM1-9/LPT1-9`，包括大小写、
带扩展名、尾随空格/点等变体（例如 `con.txt`、`AUX.`、`com1`）；`COM10` 等普通名字不受影响。

index 的完整形状如下（正文**绝不**进入 index）：

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "updatedAt": "2026-11-23T15:20:00.000Z",
  "projects": [{
    "id": "example-project",
    "directory": "example-project-0123456789ab",
    "notes": [{
      "id": "7f0b1c2d-0000-4000-8000-000000000000",
      "title": "发布决策",
      "summary": "rc.4 的交付边界",
      "updatedAt": "2026-11-23T15:20:00.000Z",
      "bytes": 1234,
      "path": "example-project-0123456789ab/7f0b1c2d-0000-4000-8000-000000000000.md"
    }]
  }]
}
```

- 根对象 strict：`schemaVersion:1`、非负安全整数 `revision`、ISO datetime `updatedAt`、`projects[]`。
- project strict：原始 board `id`、单个 sanitized lowercase `directory`、`notes[]`。note metadata strict：
  `id/title/summary/updatedAt/bytes/path`；`bytes` 是实际 UTF-8 正文大小的非负整数，`updatedAt` 在 read/list
  对账后取正文文件 mtime（create 初始值由 Host 写入，update-metadata 不伪造正文时间），`path` 是 notes 根
  相对的 POSIX 路径，不是 Host 绝对路径。工具结果额外派生 `absolutePath`，但不落盘。
- 未知字段、重复 project id、重复 directory、项目内**忽略大小写**的重复 note id、全局**忽略大小写**的
  重复 note path、Windows 保留设备名、非法时间、绝对/反斜杠/空 segment/`.`/`..`/path traversal，
  以及任何不等于精确 `<project.directory>/<note.id>.md` 的 metadata path 都拒绝。path 按 schema 校验后才能拼到固定 root。
- 限制：index 序列化文件 **≤128 KiB**，单 note UTF-8 正文 **≤256 KiB**，最多 50 个 project entries、
  每项目 **≤100 notes**；project/note id ≤128、directory ≤128、title ≤200、summary ≤500、
  root-relative path ≤512 个 UTF-16 code units。超限是 `BOARD_LIMIT_EXCEEDED`，其它 schema/参数错误是
  `BOARD_INVALID`，均带可用的 RFC 6901 pointer。
- protocol 的 `createDevLeadNotesIndexSchema()` / `parseDevLeadNotesIndex()` 与 `DEVLEAD_NOTES_*` 常量是
  Host 和浏览器唯一共享的 schema/limits 来源；浏览器 client-safe entry 不 import Host/Node。

### Store、原生正文与惰性对账 / CAS

`ctx.devLead.notes` 是与 `ctx.devLead.board` 同步创建、重试、切换和关闭的
`DevLeadBoardNotesStore`。`start()` 只在已解析 board path 下预创建 notes root 并 fresh read；start 失败与
board 一样只记 warning / `boardStartError`，不阻塞 DevLead 加载。notes store 自己不留 watcher/timer；
每次操作 fresh read，最多 4 次比较 `mtimeMs/size/ino` 与实际字节，持续变化映射为 `BOARD_IO_ERROR`。
index 与正文都使用 fatal `TextDecoder('utf-8', {fatal:true})`，因此即使字节数与 metadata 一致，非法 UTF-8
仍是 `BOARD_INVALID`，不会被替换字符静默吞掉。index 不存在等价于空
revision-0 index，不是错误；坏 UTF-8/JSON/schema/超限保留最后合法 cache 供摘要使用，但读写失败，绝不拿旧
cache 覆盖坏 index。

**职责分离**：`write` 只负责 `create`（可选 initial content，默认空）、`update-metadata`（title/summary）
与 `delete`。工具面已移除 `update` / `append` 与 `expected_bytes`，正文不做 CAS；单活 lead 使用 DSH 原生
read/write/edit 修改工具结果返回的 `absolutePath`，接受 last-write-wins。`absolutePath` 由 Host 从已验证的
project directory + note id 派生，只出现在工具结果，不进入 strict index schema。

- `read({project,note?})`：先在当前合法 board 快照上按精确 id、workspace title 或绝对 workspace path
  解析 project（title 歧义仍为 `BOARD_PROJECT_AMBIGUOUS`），再读 index。省略 note 对该项目**全部** notes
  做列表与对账；指定 note 只对选中 note 对账并返回有界 Markdown `content`，完整结果超过 64 KiB 时截断并标
  `truncated:true`。list/read 结果的每条 metadata 都同时带 root-relative `path` 与 Host `absolutePath`。
- **惰性对账**：read/list 与 write 共用 Host 内 promise 链，并进入 **index 文件的 `withFileLock`**。
  锁内 fresh read 后逐条读取稳定正文快照，比较实际 bytes 与文件 `mtime`（ISO `updatedAt`）。若选中范围内有
  变化，先基于同一份 fresh index 构造完整 next、strict-validate，再一次性原子提交：index `revision + 1`、
  index `updatedAt` 推进，相关 note 只修 `bytes/updatedAt`，title/summary/path 不变。并发 read/list 串行后
  只提交一次实际修复。对账绝不调用正文写 API，因此不会用旧 cache 或旧正文覆盖原生编辑。
- **失败不破坏 index**：所有选中正文先验证成功才允许提交。文件缺失为 `BOARD_NOTE_NOT_FOUND`；超过
  256 KiB 为 `BOARD_LIMIT_EXCEEDED`；非法 UTF-8 为 `BOARD_INVALID`。任一项失败时整个 read/list 返回结构化
  错误、旧 index bytes 保持不变；summary 只按既有 cache-safe 规则降级。修复 index 本身失败也不会回滚或覆盖
  原生正文。下一次 read/list 会再次从磁盘 fresh read 并对账。
- `write(patch,signal?)`：同样在 Host promise 链 + index 文件锁内 fresh read、校验 CAS、构造并
  strict-validate 完整 next index，最后原子写 index。`expected_revision` 是可选的**全 index CAS**，适用于
  create/update-metadata/delete；锁内 revision 不同即 `BOARD_REVISION_CONFLICT`，任何文件都尚未修改。
  取消按标准 `AbortError`，不伪装成领域错误。
- create 的顺序是**初始正文原子写 → index 原子提交**。index 是提交事实：正文先存在但未被 index 引用只是
  ignored orphan；index 提交失败会 best-effort 删除新正文，绝不把 orphan 当已提交 note。create/update/delete
  的 index 与初始正文文件为 `0600`、目录 `0700`。update-metadata 只改 title/summary，保留正文 live mtime；
  无实际变化不写文件、不 bump revision，返回 `changed:false`，也不要求正文存在。
- delete 先提交移除 metadata 的 index，再 best-effort 删除正文；删不掉的正文成为 ignored orphan，不回滚
  已提交删除。delete 不读取正文，可以修复“有 metadata、正文已缺失/非法”的 stale index。删除项目最后一条
  note 时同时移除空 project entry。原子替换不等于 fsync 或跨多文件事务/掉电持久性保证。

### 坏 index、orphan 与 board 重建后的恢复

先执行 `/devlead off`（或停止 Host），确保没有 writer，再备份整个 `dirname(boardPath)/notes/`；不要在与
active lead 并发写入时手改文件。恢复后重新 `/devlead on`，store 会 fresh read 并 strict-validate：

- **坏 JSON / 非法 UTF-8 / schema 错误**：保留备份，修复 `notes/index.json` 后重试。若只需丢弃全部
  notes 重新开始，可删除整个 notes 目录；board.json 不受影响。不要用最后合法 cache 或空 projects 静默
  覆盖坏 index。
- **未入 index 的 orphan 正文**：它们不参与 listing、摘要不计数，也不占每项目 100 条的 metadata 上限；
  可在备份后删除未被任何 `metadata.path` 引用的 `.md` 文件。提交失败或 delete 清理失败留下的 orphan 可
  安全按此方式回收。
- **board 重建/项目 id 改换后滞留的旧 project entries**：这些 metadata 仍可能占用 50 projects / 每项目
  100 notes 上限。手工编辑 `notes/index.json`，删除不再需要的 `projects[]` entry，并保持剩余 entry 的
  schema、path、revision 类型有效；下一次成功 mutation 会推进 revision。若旧 notes 全部不再需要，删除
  整个 notes 目录是更低风险的完整清理方式。若只想移除仍存在于当前 board 的项目中的一条 stale note，
  优先用 `devlead_board_note_write delete`，它也能修复正文已缺失或非法的 metadata。

### Notes AI 工具

两个工具与原有两个 board 工具一样带 `when: ({agent}) => ctx.devLead.isEnabled(agent)`，共用
`assertKnownArguments`，并经 `ctx.devLead.readBoardNote` / `writeBoardNote` 再校验调用者是当前 active
lead。**四个 board/notes 工具都没有文件路径参数**；`project` 只看板 id/title/path 引用，`note` 只是 id。

#### `devlead_board_note_read`

参数：`project`（必填）、`note?`。project 解析规则与 board 工具相同。省略 note 返回：

```ts
{ revision, updatedAt, project: { id, directory }, notes: Array<DevLeadNoteMetadata & { absolutePath: string }> }
```

项目尚无 notes 或 index 不存在时 `notes: []`。指定 note 时省略 `notes`，返回：

```ts
{ revision, updatedAt, project: { id, directory }, note: DevLeadNoteMetadata & { absolutePath: string, content: string }, truncated?: true }
```

**单 note 模型读取上限 64 KiB**：上限与 `devlead_board_read` 相同，按**完整 JSON 结果的 UTF-8 字节数**
计算（含 metadata 与 `truncated` 字段），不是只截正文到 64 KiB。超限时 `content` 保留原文前缀，按 Unicode
码点边界截断并返回 `truncated:true`，不会切出半个 surrogate pair；`note.bytes` 仍是磁盘完整正文字节数。
磁盘上限 256 KiB 与浏览器 reader 的完整读取不变。当前没有 offset/limit 分页参数，需要后半段时应由 Host
文件维护者拆分 note；不要把截断结果误当全文覆盖写回。模型需要修改正文时，应对结果里的 `absolutePath`
使用 DSH 原生 read/write/edit，不要手改 `notes/index.json`，并保持文件 ≤256 KiB 且为合法 UTF-8。未知
metadata id 或 indexed body 缺失为 `BOARD_NOTE_NOT_FOUND`；list 遇到缺失、坏 UTF-8 或超限同样失败并保留
旧 index。完成态卡片只显示项目、revision 与 note 数/标题/截断标记，不重复 Markdown 正文。

#### `devlead_board_note_write`

参数：`project`、`operation: create|update-metadata|delete`、`note?`、`title?`、`summary?`、仅 create 的
`content?`、`expected_revision?`。各 operation 的字段约束：

| operation | 字段与行为 |
| --- | --- |
| `create` | 非空 `title` 必填；`note` 可省略以生成 UUID；`summary` 默认空、可选 initial `content` 默认空。忽略大小写的重复 note id 拒绝 |
| `update-metadata` | `note` 必填；只替换实际提供的 `title/summary`，省略字段保持不变；title trim 后不能为空；不接受 content |
| `delete` | `note` 必填；不接受 title/summary/content；按上述 index-first 语义删除 |

返回 `{revision,updatedAt,project:{id,directory},note,operation,changed,deleted?}`，其中 note 是结果或
被删除的 metadata + `absolutePath`，**不回传正文**。后续正文只能经原生文件工具编辑该路径；工具没有
update/append 或 expected_bytes。稳定 notes 相关错误码复用 `BOARD_DISABLED`、`BOARD_NOT_FOUND`、
`BOARD_INVALID`、`BOARD_PROJECT_NOT_FOUND`、`BOARD_PROJECT_AMBIGUOUS`、`BOARD_REVISION_CONFLICT`、
`BOARD_LIMIT_EXCEEDED`、`BOARD_IO_ERROR` 与 `BOARD_NOTE_NOT_FOUND`；工具层映射为同 code 的 `HarnessError`。

## Lead 的 board / notes 工作流引导

`tool` 包另注册独立的 `devlead:board-policy` system prompt section，仅对 `ctx.devLead.isEnabled(agent)` 的 lead
可见，普通 Session 与无 Agent 的组装均为空；它不占用 `DEVLEAD_POLICY_BASE` 的尺寸预算。引导把每轮注入的
board summary 视为跨项目状态事实源：派发/收口或 focus、next、blockers、tasks 有实质变化时批量更新看板；
恢复项目或写派发简报前优先用 `devlead_board_note_read` list/read；计划、设计、决策与交接先通过
`devlead_board_note_write` create/update-metadata/delete 维护索引，再用 DSH 原生 read/write/edit 编辑返回的
absolutePath 正文，需要时再用工具更新 title/summary，绝不手改 notes/index.json。向用户汇报前先对齐过期状态。
内容应简短可读、合法 UTF-8 且 ≤256 KiB，不整段复制聊天、日志或工具输出；`BOARD_DISABLED` / `BOARD_IO_ERROR`
时继续主任务、只报告一次降级且不反复重试；没有实质变化时不为“勤更新”制造噪声。base policy 与两个 notes
工具描述也同步这套职责分离。

## AI 工具

四个 board/notes 工具均带 `when: ({agent}) => ctx.devLead.isEnabled(agent)`，并与其他工具共用
`assertKnownArguments`。

### `devlead_board_read`

参数：`project?`、`include_tasks?`、`limit?`。project 支持精确 id、workspace title 或绝对
workspace path；title 歧义返回 `BOARD_PROJECT_AMBIGUOUS`。省略 project 返回有界项目列表，
默认不含 tasks，`limit` 最大 50，超出列表上限时 `truncated:true`。单项目默认含 tasks，但最多
返回 50 条，超出时同样 `truncated:true`。结果为 `{ revision, updatedAt, projects, truncated? }`。

**序列化上限 64 KiB**：文件本身上限 256 KiB，但一个项目仍可能带多条 4000 单位的 tasks/blockers，
所以工具结果另有 `DEVLEAD_BOARD_READ_MAX_BYTES = 64 * 1024`（protocol 常量，Host 与浏览器共用
同一份）。超限时按固定顺序**从尾部整行裁剪**：先 tasks，再 blockers，最后整个 project 行；
revision/updatedAt 与靠前的项目永远保留（project 行最多裁到只剩一个，因为单个 project 的标量
字段远低于上限），裁过任何行都报 `truncated:true`。只裁整行，结果仍满足 schema v1。

### `devlead_board_update`

参数：`project`、`expected_revision?`、`create?`、`set?`、`blockers?`、`tasks?`。
创建必须显式 `create:true` 并提供 `set.workspace.path`；此时 `project` 是新 id。

**project 引用在锁内快照上解析（P2-1）**：`project` 参数允许 workspace title / 绝对 workspace
path，两者都可能远超 id 的 128 单位上限。写入预检因此针对固定的 synthetic project id
（`devlead-validation`）验证 patch 形状，而不把调用者的引用当 id 做长度校验；因此长
workspace path/title 不再误报 `BOARD_LIMIT_EXCEEDED`。引用是否存在、是否歧义由锁内 fresh read
的真实 board 决定：未知引用仍是 `BOARD_PROJECT_NOT_FOUND`，title 命中多个仍是
`BOARD_PROJECT_AMBIGUOUS`。

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
而不是每轮变化的 system section。仅 enabled lead 且缓存中有项目时非空；没有 active lead、
看板 degraded、未加载或空 projects 返回空串。首行格式：

```text
DevLead board r<rev> <updatedAt>; projects N: active a, blocked b, paused c, done d
```

随后每项目一行，含 id/title、status/priority、截断 focus 和 blocker 数量。**active** 项目若在合法
notes cache 中有 notes，还追加 `notes:N` 与最近 note 的 `latest:"<title>"`；没有 notes、非 active 项目或
notes 尚不可用时不伪造这些字段。project id、workspace.title、focus 与 latest title 中的控制/格式字符
先替换并折叠为单行空白，防止注入额外摘要行；latest title 另有 80 码点截断，focus 为 120 码点。整个摘要
（board + notes 信息合计）不超过 **1536 UTF-8 bytes**，按完整行截断。相同文本由 DSH 复用，board/notes
index 提交或 read/list 对账后的新 revision 在下一次上下文重建生效；单纯原生正文编辑不会同步注入摘要，
直到下一次 note read/list 完成惰性对账。摘要总是当前 active lead 文件的摘要；切换 lead/路径后立即
换源。外部坏 index 会让 notes 读写失败，修复前摘要只按 cache-safe 降级规则保留**最后合法** metadata，
绝不把未索引 orphan 或坏文件内容当作新提交。

## Step B 浏览器契约

Host 只在**当前 active lead 拥有看板路径时**注入 global：每次 `webserver/index-inject` 渲染
时写入；没有 lead 时不注入（有 active lead 时，路径来自 workspace 派生或 Config override，
因此 lead 自身没有 workspace 根也有 override 路径可发布）。看板 start 失败（degraded）仍按
当前 lead 发布 global：路径已经确定，浏览器面板照常打开并显示空态/读取错误（`BOARD_IO_ERROR`）。

```ts
window.__DSH_DEVLEAD_BOARD__ = {
  boardPath: '/path/to/workbox/.dsh/devlead/board.json', // 派生路径或 Config override
  schemaVersion: 1,
  pathPlatform: 'posix', // Windows Host 为 'win32'
  leadSessionId: 'session-...', // 页面渲染时持有看板的 active lead
  override: false, // boardPath 是否来自部署 Config override
}
```

`dsh.client.inject` 是**静态**包声明，共 11 项，不由看板开关或 lead 状态增删：
`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-api-session-controller`、
`@deepseek-ai/dsh-api-workspace-controller`、`@deepseek-ai/dsh-api-workspace-files`、
`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-conversation`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-renderer`、
`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-sidebar-right`、
`@deepseek-ai/dsh-client-ui-workspace`。实现不新增 board RPC，也不向浏览器暴露任何写能力；
client 按官方右栏插件契约静态组合 `remote.workspaceFiles`、`sidebarRight`、
`sidebarRightTabs` 与 `workspaces`。

**看板入口只属于 eligible lead**：eligible = **屏幕上的 top-level Session，且其 summary 级
`devLeadMode` 投影为 enabled**（subagent Session 永不合格）。右侧栏看板 tab type、guide entry、
`sidebar.right.pane.tab` body 与 title 只在该 Session 显示时动态注册；会话头
`conversation.session.header.utilities` 按钮对每个 Session 注册，但组件用同一组 summary 事实
自门控，因此只在 eligible lead 上渲染。非 lead Session、subagent Session、lead 关闭后的旧
面板都不显示入口；按钮点击时也会同步修复注册再 `openTab`，跨列表通知的点击不会落在未知
kind 上。模式 off、Session 切换、路径切换会立即重渲染并 dispose 旧面板且关闭遗留 tab，绝不
继续读旧文件；同一 pane 重复点击复用页面。

**global 缺失时的自愈**：如果页面是在 lead 启用之前加载的（HTML 里没有 global），client 会从
屏幕上该 eligible lead Session 的 summary `cwd` 自行派生默认路径
`<cwd>/.dsh/devlead/board.json`（与 Host 使用 protocol 的同一份目录段常量与相同的
`node:path.join` 语义，Windows 盘符/UNC 也做规范化），path platform 取 global 已知的
`pathPlatform`，没有 global 时按 `cwd` 语法识别 `/`（posix）或盘符/反斜杠（win32）——只用于
语法判断，仍要求 cwd 是该平台的绝对路径。因此默认路径部署不需要刷新页面也能出现入口。
**使用 Config `boardPath` override 的部署在这种 late-enable 场景需要刷新页面**：只有刷新后的
HTML 才携带 override 的真实路径与 `override:true`；client 不会把 override 路径猜成默认路径。
global 存在但页面渲染后换了 lead 时，client 按 `leadSessionId` 判定归属，不匹配就回到从当前
屏幕 lead 的 summary 派生；`override:true` 的 global 是部署级路径，对所有 lead 生效。
派生路径的 workspace 根已不存在时 Host 不发布 global；但页面在 late-enable 场景下仍可能按
summary `cwd` 自愈派生默认路径，此时只读面板显示空态/读取错误（浏览器只做 `stat`/`readBytes`，
不会创建目录或写入），Host 侧的看板仍是 disabled。

global 的 `leadSessionId` / `override` 是**additive** 字段：旧 Host 的 global 缺这两个字段时，
client 按旧部署级宽路径语义继续工作；旧 client 会忽略新字段。

- tab definition：`kind: 'devlead-board'`，`id: '@yankeguo/dsh-client-ui-devlead/board'`；标准
  guide entry 与会话头按钮通过 `sidebarRight.openTab(kind)` 打开。body slot 是
  `sidebar.right.pane.tab`，其 `key` 是 definition 的 **id**（不是 kind）。
- `useBoardFile`：以当前 tab 的 SessionId 与解析出的看板路径调 `stat` + `readBytes(..., {})`，
  并直接消费 `changes`。首读与 ready 后重读关闭订阅竞态，change 经 **120ms debounce** 重读；卸载
  abort 读取/watch 并 `dispose()` stream，旧 request generation 不能覆盖新结果。**所有文件状态都有
  周期轮询**：ready/loading 默认按固定 **5s** 节奏读取，empty/error 从 **5s** 起指数退避
  （5s → 10s → 20s → 30s），上限 **30s**；`refreshing` 切换不重置退避。只有 document 同时
  visible 且 focused 时才运行 timer，顶部 Live 状态区分自动刷新 active/paused/disabled。
  `visibilitychange` / focus 恢复立即触发一次 coalesced read；blur、hidden、unmount 与 path change
  都清理旧 timer。watch、poll、focus/visibility 恢复共享同一 in-flight 读取，在途期间新到的 watch ready/change 合并为
  **一次 trailing refresh**（poll/focus 只共享当前读取），避免叠发或丢失后续 change；手动刷新仍可强制取代在途读取、重读文件并
  重建 watch。**watch ended 不静默自动重连，但周期轮询继续**，
  面板明确区分文件监听与自动轮询状态，不再要求只能靠手动刷新获得后续更新。路径/lead 变化时重新
  resolve 配置并从空态开始，旧文件的缓存内容不得延续。
- 浏览器解码器直接使用 protocol 的同一份 strict schema v1（不 import Host/Node 模块；schema
  源码内联进浏览器 bundle，`zod` 走 DSH 冻结 module table 的 platform singleton——Step B 起
  `board.ts` 就依赖它，没有新增浏览器运行期依赖），拒绝坏 UTF-8、坏 JSON、未知字段、
  重复 id/重复 workspace path、
  错误枚举和超限文件。绝对路径按 Host 显式发布的 `pathPlatform`（global 存在时）或浏览器平台
  谓词选择 `node:path.posix` / `node:path.win32` 语义，不从路径字符串猜测。文件不存在是
  「还没有看板数据」；Remote 错误是读取错误；JSON/schema 错误是
  解析错误，显示最后成功时间与重试，不保留旧项目卡片。`devlead_board_read` 的 64 KiB
  裁剪只作用于**模型工具结果**；右栏面板直接读取看板文件（受 schema 的 256 KiB 文件上限约束，
  不经工具层裁剪），两者互不影响。
- 项目按 blocked / active / paused / done 分组，同组按 high / medium / low、updatedAt 倒序、id
  稳定排序。顶部展示 active/blocked/paused/done KPI、revision、updatedAt 相对时间与 Live 自动
  刷新状态；四状态 KPI 是**单行 pill strip**，revision/updated/Live 为紧凑元信息。blocked 以强警示
  置顶，active 为主内容区，container ≥620px 为 2 列、≥980px 为 3 列、窄栏 1 列。紧凑卡片不重复显示
  可见 field labels（字段名保留 sr-only/aria），但仍展示 workspace、focus/next/blockers、任务
  done/total 进度条与原生 `<details>` 任务清单；展开任务会同时解除 focus/next/goal/blocker/task
  的 line-clamp，全文不只能依赖 hover。非自明图标带 tooltip/可访问名称。paused/done 与
  「未在看板中的项目」使用次级折叠。样式覆盖 light/dark，标题关联、状态 live region、进度值、窄栏
  焦点顺序等 aria 与原生键盘 disclosure 均可验收，且没有编辑控件。视觉 busy/「正在刷新」文案与 polite
  live region 分离：5s 轮询造成的 refreshing 翻转不进入播报区域，只有健康/生命周期状态迁移与错误播报，
  避免读屏软件每个周期重复提醒。
- 「未在看板中的项目」折叠区只连接 Host 的 `useWorkspaces` / `useSessions` 投影，按 workspace
  path 过滤（POSIX 尾斜杠、Windows 分隔符/大小写做语法规范化），显示名称、path、会话数和这些
  Sessions 的最新 updatedAt；Session 清单 pending 时显示读取中，不谎报无活动。workspace 清单
  读取失败时**错误优先于 pending**（即使投影 phase 仍为 pending 也显示错误，不把失败误标成
  “读取中”），看板文件未就绪时只显示「不可用」。symlink/realpath 别名仍需 Step C 由 Host
  权威解析，浏览器不伪造 canonicalization。组标题的 DOM id 用 React `useId` 前缀，多个面板
  实例同时挂载也不会冲突。
- **notes 路径与读取**：client 从已经解析的 board config 直接派生
  `dirname(boardPath)/notes/index.json`，目录名/文件名与 limits 复用 protocol 常量。project 只按原始
  board project id 关联 notes entry；正文路径只接受 strict schema 已证明的 metadata.path，再按 Host
  `pathPlatform` 拼到固定 notes root。没有任意路径输入、自定义 Remote、写 API 或乐观写状态。
  `useWorkspaceFile` 是 board、notes index、当前 note 共用的只读 `stat/readBytes/changes` 状态机；
  index 在面板可见时持续 watch+poll，正文只在 reader 打开时 watch+poll，关闭后立即 abort/dispose。
  外部修改 index 会刷新 chips/list/selection，外部直接修改当前 note（不经过 notes 工具）会由 watch+poll
  自动刷新正文；response 还带 valuePath 代际核对，旧 note 的慢响应不能覆盖新选择。`useWorkspaceFile` 在
  path 切换的 render/effect 间隙也会按 `valuePath !== config.path` 隐藏旧 value 并显示 loading，chips 与
  已打开 reader 不会短暂借用旧 workspace metadata。`useDevLeadNote` 的 memo key 只含 `id/path`（加 notes
  root/platform），不含可能过期的 index bytes：index title/summary/updatedAt/bytes 刷新不会重建正文 watch，
  正文代际完全由 live stat/readBytes 决定。成功结果同时暴露与 stat 配对的 `observedAt/observedBytes`。
  DSH 0.2.2 的 `WorkspaceFileStat.version` 是 opaque freshness token、没有 mtime，client 不解析它；
  `observedAt` 是 client 成功 stat 的观察时间而非文件系统 mtime。只有当前 ready 且路径匹配的 reader 标题栏
  优先显示该 live 时间，list 排序/时间和 chip 最新标题仍使用 index metadata，缺文件/错误时回退 index 时间。
  空/加载/读取/解析/超限/watch ended 分开呈现，坏 index 只显示 notes unavailable notice，坏 note 只降级
  当前 reader，board 卡片与原自动刷新不受影响。
- **notes chips 与全栏 reader**：项目只有实际 note 时才显示 chip，包含 note 数与按 updatedAt 最近
  的标题；长标题截断但 tooltip/aria 保留全文。打开后 reader 占满整个 board content，而不是某个卡片
  column：宽栏为 notes list + document 两条 reading lanes，≤560px 上下堆叠。reader 展示项目、数量、
  note title/summary、当前正文 live stat 观察时间（未 ready 时回退 index updatedAt）、正文与返回按钮，
  可切换 note；打开时聚焦返回按钮，关闭后恢复原项目
  chip；当前 note 从 index 消失时回退到现存最新 note，空 index 显示空态。正文使用无依赖的
  `DevLeadMarkdown` 安全子集：headings、段落、有序/无序
  列表、blockquote、fenced/inline code、bold/italic/strikethrough 与显式 HTTP(S) links。raw HTML 和
  javascript/data 等危险 scheme 保持惰性文本，链接带 `target=_blank` + `rel=noreferrer noopener`；
  **不使用 `dangerouslySetInnerHTML`**，reader 无编辑控件。

所有样式沿用 `ensureStyleTag` 与 `--dsw-*` token，文案在 `devlead` namespace 的 zh/en 词典。
自动化覆盖的边界：纯函数（schema/分组/排序/相对时间/unlisted 规范化）、`Remote` hook 的
加载/分帧/全状态轮询/退避/visibility-focus 暂停恢复/in-flight 去重/降级/abort 状态机，以及
`react-test-renderer` 的组件分支、只读性、XSS 文本转义与 a11y 属性；真实浏览器中的视觉、主题、
轮询节奏与交互仍按
[UI-VERIFICATION](UI-VERIFICATION.md) 在隔离 profile 人工验收，不由单测替代。Step C 可在
不修改文件所有权的前提下复用 `DevLeadBoardPanelView` 做全页视图，或另加 Session 跳转/自动状态合并。
