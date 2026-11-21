# @yankeguo/dsh-devlead-bundle

The npm bundle that upgrades one ordinary [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) session into a **DevLead session**: it ships the core host service, fourteen lead
`devlead_*` tools plus the watched-child `devlead_report` tool, the human `/devlead` command, and
the browser UI (composer-toolbar switch, read-only status strip, sidebar marks).

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

## What's inside

The bundle's patch inserts four plugin rows:

| entry id | package | role |
| --- | --- | --- |
| `devlead` | `@yankeguo/dsh-devlead` | Host core service `ctx.devLead`: durable mode switch, Workspace/Session orchestration, notification hub, Session projections |
| `devlead-tool` | `@yankeguo/dsh-tool-devlead` | Fourteen lead `devlead_*` tools plus `devlead_report`, and the conditional DevLead system prompt |
| `devlead-command` | `@yankeguo/dsh-command-devlead` | The human `/devlead` command: status, on/off, reset, watch/unwatch |
| `devlead-ui` | `@yankeguo/dsh-client-ui-devlead` | Browser UI: composer-toolbar switch, read-only status strip, sidebar active/watched marks — renders on the DSH **Web** platform |

## Learn more

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) · [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md): domain model, durable records, service API, notification pump
- [Compatibility notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/COMPATIBILITY.md): the supported DSH surface
- [v0.4.0 release notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/releases/v0.4.0.md) · [GitHub Releases](https://github.com/yankeguo/dsh-devlead/releases)
- Package READMEs: [protocol](https://github.com/yankeguo/dsh-devlead/blob/main/packages/protocol/README.md) · [devlead](https://github.com/yankeguo/dsh-devlead/blob/main/packages/devlead/README.md) · [tool](https://github.com/yankeguo/dsh-devlead/blob/main/packages/tool/README.md) · [command](https://github.com/yankeguo/dsh-devlead/blob/main/packages/command/README.md) · [client-ui](https://github.com/yankeguo/dsh-devlead/blob/main/packages/client-ui/README.md)

## License

MIT. See [LICENSE](https://github.com/yankeguo/dsh-devlead/blob/main/LICENSE).

## 中文

`@yankeguo/dsh-devlead-bundle` 是 DevLead 套件的安装入口：把 DSH 的一个普通会话升级为 DevLead
会话，内含核心服务 `ctx.devLead`、14 个主 `devlead_*` 工具加 1 个 `devlead_report` 汇报工具、
人类 `/devlead` 命令，以及浏览器端 UI（composer 工具条开关、只读状态条、侧边栏标记；UI 只在
DSH Web 平台渲染）。

安装，或从 Web 的 **Plugins → Add plugin** 输入包名安装：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

安装后在 Plugins 页面确认 bundle 已启用（通常默认启用），刷新页面。要打开 DevLead，在目标
会话执行 `/devlead on`（人类专属操作；也可点 composer 工具条里的 DevLead 图标 + 文本按钮）。
同一 Host 同一时间只能有一个 DevLead 会话，关闭用 `/devlead off`。

更多文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)；License 为 MIT，
见 [LICENSE](https://github.com/yankeguo/dsh-devlead/blob/main/LICENSE)。
