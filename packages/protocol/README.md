# @yankeguo/dsh-devlead-protocol

Pure shared protocol for the DevLead plugin suite: durable record payloads, Session projection
types, the strict project-board and project-notes wire schemas (both v1), formatting helpers, and the
constants both the Host and the browser bundle use. It is the only package both halves share: the
board's default path segments (`DEVLEAD_BOARD_DIR_SEGMENTS`, `DEVLEAD_BOARD_FILE_NAME`) and the
`DEVLEAD_BOARD_READ_MAX_BYTES` tool-read cap live here, so the Host (which derives
`<lead header.cwd>/<statePath>/board.json`, with deployment `statePath` defaulting to `.dsh/devlead`)
and the browser (which derives the same default path from the Session summary `cwd` when the page-load
global is absent) cannot drift. Notes constants identify `<workspace>/<statePath>/notes/index.json`
(equivalently, the already-resolved absolute `dirname(boardPath)/notes/index.json`), cap the index at
128 KiB and each Markdown body at 256 KiB, and limit each project to 100 notes. The wire fields and
schema are unchanged by the deployment-key rename.

This package has **no runtime dependency** on any DSH package. Its single DSH import is a
type-only projection-map augmentation; it is erased at build time. The one third-party runtime
dependency is `zod`, which builds the board and notes-index schemas shared by the Host validators and
browser decoders: both published entries bundle it, so an installed profile does not need to resolve `zod`
for the Host half, while DSH's browser build imports the frozen module table's `zod` platform
singleton (the same module `client-ui` already relied on). Installing this package alone does not
enable DevLead — install the bundle (below) to get the host service, tools, command, and UI.

## Install

Normally installed as part of the main bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

Only install this package directly when you are composing the suite yourself.

## Exports

| Export | Contents |
| --- | --- |
| `@yankeguo/dsh-devlead-protocol` | Host entry; re-exports the client-safe surface |
| `@yankeguo/dsh-devlead-protocol/client` | Browser-safe constants, types, pure formatting helpers, the shared board and notes-index schema factories/parsers, and the default board path segments / read cap |
| `@yankeguo/dsh-devlead-protocol/package.json` | Package manifest |

The public contract includes the `devLead` / `devLeadMode` / `devLeadWatch` projection keys and
types, durable `plugin:devlead/*` record types and their version (mode / watch / notification /
**report** / **reset**; `DevLeadResetRecord` discards every earlier DevLead record of a Session and
restarts all three projections from their empty state), the summary-sized `DevLeadWatchProjection`
(`{ sessions }`, used by the sidebar to mark watched rows), the watched-child `DevLeadReport` receipt
(`kind`, `message`, `summary?`, sender/lead ids, turn; bounded message/summary), retention/excerpt/
instant constants, transition/report-kind vocabulary, `devLeadReportId`, `reportLine`,
`notificationLine` / `excerptLine` / `formatInstant`, the `DevLeadUseWorkspaceRequest` shape
(`{ path, title?, create? }`, `create` defaults to `false`), and the `DevLeadIsolation` outcome
carried by the required `DevLeadCreatedSession.isolation` field, plus the project-board contract:
the schema version, byte/count/length limits, the default path segment constants, the 64 KiB
`DEVLEAD_BOARD_READ_MAX_BYTES` read cap, durable project/blocker/task types, and
`createDevLeadBoardSchema(isAbsolutePath)` — one strict decoder both the Host (with its own
`node:path.isAbsolute`) and the browser (with the Host-published `pathPlatform`) consume, including
duplicate project/workspace-path/blocker/task rules, UTC-only timestamps, and strict unknown-field
rejection. The notes contract adds `DevLeadNotesIndex` / `DevLeadNotesProject` /
`DevLeadNoteMetadata`, `createDevLeadNotesIndexSchema()` and `parseDevLeadNotesIndex()`, plus
`DEVLEAD_NOTES_*` path and limit constants. Its strict schema-v1 index is
`{ schemaVersion:1, revision, updatedAt, projects:[{ id, directory, notes[] }] }`; metadata rows are
`{ id, title, summary, updatedAt, bytes, path }`. Unknown fields, duplicate project ids/directories,
duplicate note ids/paths, unsafe absolute/traversal paths, and any path other than the exact
`<project.directory>/<note.id>.md` are rejected. Note bodies never appear in the index. Host tool results may
derive an additional `absolutePath` for DSH-native body editing, but that field is deliberately not part of this
wire schema and is never persisted.
`client-ui` imports these constants and decoders from this package instead of depending on the Host
core package.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-devlead-protocol` 是 DevLead 套件的纯协议包：host 与浏览器共用的类型、常量、
projection 键（`devLead` / `devLeadMode` / `devLeadWatch`）、`plugin:devlead/*` 持久记录类型（mode / watch / notification / report / reset）、项目看板与项目 notes 的严格 wire schema v1，以及格式化函数和请求/结果形状。看板导出 `createDevLeadBoardSchema(isAbsolutePath)`、limits、持久类型、重复 id/path 与 UTC 时间规则、RFC 6901 issue 映射；包内另导出看板默认路径段常量（`DEVLEAD_BOARD_DIR_SEGMENTS` = `.dsh`/`devlead`、`DEVLEAD_BOARD_FILE_NAME` = `board.json`）与 `devlead_board_read` 的 64 KiB 上限 `DEVLEAD_BOARD_READ_MAX_BYTES`，Host 以部署 `statePath`（默认相对目录 `.dsh/devlead`）派生 `<workspace>/<statePath>/board.json`，浏览器在 global 缺失时派生同一默认路径，不会各写一份。notes 导出 `DevLeadNotesIndex` / `DevLeadNotesProject` / `DevLeadNoteMetadata`、`createDevLeadNotesIndexSchema()` / `parseDevLeadNotesIndex()` 与 `DEVLEAD_NOTES_*` 常量，索引路径为 `<workspace>/<statePath>/notes/index.json`（等价于内部已解析绝对 `dirname(boardPath)/notes/index.json`），wire schema 不随部署键改名：index 固定为 `{schemaVersion:1,revision,updatedAt,projects:[{id,directory,notes[]}]}`，metadata 固定为 `{id,title,summary,updatedAt,bytes,path}`；正文不进入 index，路径必须精确等于 `<directory>/<note-id>.md`。未知字段、重复 project id/directory/note id/path、绝对路径和 path traversal 一律拒绝；index ≤128 KiB、单 note ≤256 KiB、每项目 ≤100 条。它没有运行时 DSH 依赖；`zod` 是唯一的第三方运行期依赖，会被打包进两个发布入口，浏览器侧使用 DSH 冻结 module table 的 `zod` platform singleton。`@yankeguo/dsh-client-ui-devlead` 只依赖本包（不依赖 `@yankeguo/dsh-devlead`）。通常随 bundle 安装。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
