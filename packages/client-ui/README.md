# @yankeguo/dsh-client-ui-devlead

Browser half of the DevLead suite, loaded on the DSH **Web** platform.

- **Mode switch (both states):** a compact ghost button in the composer toolbar
  (`conversation.input.left`) shows the users icon plus a visible `DevLead` label and sends
  `/devlead on` while the mode is off and `/devlead off` while it is on. The same button stays
  mounted in both states; while the mode is on it gains the business-accent border and a light
  halo, with the border reserved transparent in the off state so the toolbar never shifts.
- **On state:** a status strip above the composer (`conversation.input.dock`) shows the brand,
  watched/running counts, and the newest retained notification or mid-turn report (or the help
  hint). Reports show sender, localized kind, and summary/message; the strip is display-only and
  owns no switch.
- **Sidebar marks:** the active DevLead row gets a business-accent ring (scoped by the shell's
  stable `data-row-key` row attribute through `:has`), and watched non-lead rows get a quieter
  shield (`sidebar.session.row.trailing`). The mark predicates read the summary-sized
  `devLeadMode` / `devLeadWatch` projections; the row hover card (`sidebar.session.row.hover`)
  restates active/watched for accessibility.

The browser bundle only registers into DSH client slots and sends `/devlead` commands from the
toolbar toggle. It has no custom Remote API, no optimistic state flips, and no direct Host access;
all durable state comes from the `devLead` / `devLeadMode` / `devLeadWatch` projections. The locale namespace is
`devlead` with `zh` and `en` dictionaries.

Style injection is reference-counted across **module instances** (`Symbol.for(...)` key on `globalThis`):
HMR old/new instances can coexist without an old disposer removing the `<style>` tag a new instance
still uses. The two surfaces and `useDevLeadAdmission` have React render tests using
`react-test-renderer` (devDependency only, pure node, no jsdom); the style-tag refcount is covered
by a second-module-instance test (`vi.resetModules()` + dynamic import).

Known UI limits: the marks are subject to the projection-cache backfill described in the repository
README; DSH 0.2.2-rc.1 does not render the trailing seat on a blank (no-turn-yet) Session row; and
search results use a separate row surface without that seat, so marks are absent while searching.

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

`@yankeguo/dsh-client-ui-devlead` 是浏览器半边：composer 工具条里两态都存在的 DevLead
图标 + 文本开关（关闭态发 `/devlead on`、开启态发 `/devlead off`）、开启后的只读 DevLeadBar 状态条、
侧边栏激活 lead 的强调色行环与已关注会话的弱化盾牌；只读 `devLead`/`devLeadMode`/
`devLeadWatch` projection 并发送 `/devlead` 命令。
0.2.0 起样式注入用跨模块实例引用计数（HMR 新旧实例交替不误删标签），组件与准入 hook 用
`react-test-renderer` 做渲染测试。已知 mark 回填与 blank 行限制见根 README。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
