# @yankeguo/dsh-devlead-bundle

The npm bundle that upgrades one ordinary [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) session into a **DevLead session**: it ships the core host service, eighteen lead
`devlead_*` tools plus the watched-child `devlead_report` tool, the human `/devlead` command, and
the browser UI (composer-toolbar switch, read-only status strip, sidebar marks, and the lead-only
read-only project board).

## Install

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

Or install it from the Web UI: open **Plugins → Add plugin**, enter
`@yankeguo/dsh-devlead-bundle`, and confirm. Afterwards check that the bundle is enabled on the
**Plugins** page (freshly installed bundles are usually enabled by default; tick it if not), then
reload the Web page.

## Open DevLead

In the session that should lead, run:

```text
/devlead on
```

The switch is **human-only**: no model call or tool can enable it. You can also click the
**DevLead** icon + label button in the composer toolbar — the same button stays in place in both
states and sends `/devlead on` when off and `/devlead off` when on. One Host runs at most one
DevLead session at a time; `/devlead on` in a second session is refused until the current holder
runs `/devlead off`. `/devlead` on its own prints the status view (mode, watched sessions, recent
notifications and mid-turn reports), and `/devlead reset` recovers a damaged state.

Once the mode is on, that session gains the lead tools: it can register Workspaces, create
ordinary child sessions, prompt and watch them, and be woken when they settle. The child sessions
are standard DSH Sessions — visible in the sidebar and openable by a human — not subagents.

## Project board (on by default)

The board is enabled by default and needs no configuration: the active DevLead session's original
workspace root owns `<workspace>/.dsh/devlead/board.json`, and the read-only right-Sidebar tab,
guide entry and Session-header button appear only in that lead Session. The file follows the single
active lead — turning the mode off or switching leads leaves the old file untouched and reads the
new one — and with no lead the board is disabled (the tools report `BOARD_DISABLED`, no board UI
appears).

To pin the file to a deployment-specific location instead, override loader row `devlead` in the
profile's `cordis.patch.yml` and set `config.boardPath` to an absolute JSON path (retain the other
`devlead` config keys because DSH replaces the row's whole config). `boardPath` is optional, wins
over the derived path, and existing explicit `boardPath` deployments keep working unchanged. If the
page was loaded before the lead was enabled and you use a custom `boardPath`, refresh the page once
so the browser receives the override path; the default derived path needs no refresh. Only the lead
AI writes via `devlead_board_update`; humans and browser clients are read-only. See
[docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md) for schema v1 and
the `window.__DSH_DEVLEAD_BOARD__` contract. No user path is hardcoded in this package.

Each project can also carry long-form Markdown notes outside `board.json`: the active lead uses
`devlead_board_note_read` / `devlead_board_note_write` for list/read and create/update/append/delete,
while people get a compact notes chip and an immersive, read-only Markdown reader in the board. Notes
use a bounded metadata index under `dirname(boardPath)/notes/`, locked atomic Host writes, and the same
Workspace Files read path as the board; the browser has no write API or custom Remote.

## What's inside

The bundle's patch inserts four plugin rows:

| entry id | package | role |
| --- | --- | --- |
| `devlead` | `@yankeguo/dsh-devlead` | Host core service `ctx.devLead`: durable mode switch, Workspace/Session orchestration, notification hub, Session projections |
| `devlead-tool` | `@yankeguo/dsh-tool-devlead` | Eighteen lead `devlead_*` tools plus `devlead_report`, and the conditional DevLead system prompt/context |
| `devlead-command` | `@yankeguo/dsh-command-devlead` | The human `/devlead` command: status, on/off, reset, watch/unwatch |
| `devlead-ui` | `@yankeguo/dsh-client-ui-devlead` | Browser UI: composer-toolbar switch, read-only status strip, sidebar active/watched marks, and the lead-only read-only project board — renders on the DSH **Web** platform |

## Learn more

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) · [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md): domain model, durable records, service API, notification pump
- [Compatibility notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/COMPATIBILITY.md): the supported DSH surface
- [v0.4.1 release notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/releases/v0.4.1.md) · [GitHub Releases](https://github.com/yankeguo/dsh-devlead/releases)
- Package READMEs: [protocol](https://github.com/yankeguo/dsh-devlead/blob/main/packages/protocol/README.md) · [devlead](https://github.com/yankeguo/dsh-devlead/blob/main/packages/devlead/README.md) · [tool](https://github.com/yankeguo/dsh-devlead/blob/main/packages/tool/README.md) · [command](https://github.com/yankeguo/dsh-devlead/blob/main/packages/command/README.md) · [client-ui](https://github.com/yankeguo/dsh-devlead/blob/main/packages/client-ui/README.md)

## License

MIT. See [LICENSE](https://github.com/yankeguo/dsh-devlead/blob/main/LICENSE).

## 中文

`@yankeguo/dsh-devlead-bundle` 是 DevLead 套件的安装入口：把 DSH 的一个普通会话升级为 DevLead
会话，内含核心服务 `ctx.devLead`、18 个主 `devlead_*` 工具加 1 个 `devlead_report` 汇报工具、
人类 `/devlead` 命令，以及浏览器端 UI（composer 工具条开关、只读状态条、侧边栏标记，以及仅
lead 可见的只读项目看板；UI 只在 DSH Web 平台渲染）。

安装，或从 Web 的 **Plugins → Add plugin** 输入包名安装：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

安装后在 Plugins 页面确认 bundle 已启用（通常默认启用），刷新页面。要打开 DevLead，在目标
会话执行 `/devlead on`（人类专属操作；也可点 composer 工具条里的 DevLead 图标 + 文本按钮）。
同一 Host 同一时间只能有一个 DevLead 会话，关闭用 `/devlead off`。

项目看板默认启用、无需配置：active lead 会话的原始 workspace 根拥有
`<workspace>/.dsh/devlead/board.json`，看板 tab/guide/会话头按钮只在该 lead 会话出现。需要固定
路径时，覆盖 profile `cordis.patch.yml` 中 loader row `devlead` 的 `config.boardPath`（绝对路径、
可选；保留其余 config 键，DSH 会整体替换一行的 config）。已显式配置 `boardPath` 的部署行为不变；
若页面在 lead 启用前加载且使用自定义 `boardPath`，需刷新一次页面以拿到 override 路径（默认
派生路径不需要刷新）。只有 lead AI 通过 `devlead_board_update` 写入，人类/浏览器只读；详见
[docs/BOARD.md](https://github.com/yankeguo/dsh-devlead/blob/main/docs/BOARD.md)。

每个项目还可在 `board.json` 之外保存长篇 Markdown notes：active lead 用
`devlead_board_note_read` / `devlead_board_note_write` 读取列表/全文并创建、更新、追加、删除；
用户通过项目卡上的紧凑 notes chip 打开全栏只读阅读器。notes 在 `dirname(boardPath)/notes/` 下
使用有界元数据索引、文件锁与 Host 原子写，浏览器沿用 Workspace Files 只读路径，没有写 API 或新增 Remote。

更多文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)；License 为 MIT，
见 [LICENSE](https://github.com/yankeguo/dsh-devlead/blob/main/LICENSE)。
