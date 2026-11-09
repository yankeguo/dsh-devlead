# @yankeguo/dsh-client-ui-devlead

Browser half of the DevLead suite, loaded on the DSH **Web** platform.

- **Off state:** a compact ghost icon in the composer toolbar (`conversation.input.left`) sends
  `/devlead on`.
- **On state:** a status strip above the composer (`conversation.input.dock`) shows the switch,
  watched/running counts, and the latest retained notification; the switch sends `/devlead off`.
- **Sidebar marks:** enabled Sessions get a shield mark (`sidebar.session.row.trailing`) and a
  line in the row hover card (`sidebar.session.row.hover`), read from the summary-sized
  `devLeadMode` projection.

The browser bundle only registers into DSH client slots and sends `/devlead` commands. It has no
custom Remote API, no optimistic state flips, and no direct Host access; all durable state comes
from the `devLead` / `devLeadMode` projections. The locale namespace is `devlead` with `zh` and
`en` dictionaries.

Known UI limits: the mark is subject to the projection-cache backfill described in the repository
README, and DSH 0.2.2-rc.1 does not render the trailing seat on a blank (no-turn-yet) Session row.

## Install

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: browser UI, slots, locale and accessibility](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit: client inject ids](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-client-ui-devlead` 是浏览器半边：未开启时的 composer 工具条图标、开启后的
DevLeadBar、侧边栏会话行标记；只读 `devLead`/`devLeadMode` projection 并发送 `/devlead`
命令。已知 mark 回填与 blank 行限制见根 README。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
