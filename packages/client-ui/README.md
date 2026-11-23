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
  stable `data-row-key` row attribute through `:has`) and deliberately no trailing glyph; watched
  non-lead rows get a quieter target glyph (`IconGoalOutlineRegular`, `sidebar.session.row.trailing`).
  The mark predicates read the summary-sized `devLeadMode` / `devLeadWatch` projections; the row
  hover card (`sidebar.session.row.hover`) restates active/watched for accessibility.
- **Read-only project board:** the board is enabled by default for the *eligible lead* — the
  on-screen top-level Session whose summary says DevLead mode is on. Only then does this package
  register the right-Sidebar page (`devlead-board`), its guide card, live tab title, and Session
  header action; the header action itself stays registered statically and renders nothing for any
  other Session. The page strictly validates schema v1 bytes, follows `workspaceFiles.changes`,
  groups/sorts project cards, and exposes only refresh/disclosure controls. A collapsed section
  joins the authoritative Workspace/Session projections to show registered Workspaces absent from
  the board.
  The path comes from the Host global `__DSH_DEVLEAD_BOARD__` when it names this lead
  (`{ boardPath, schemaVersion, pathPlatform, leadSessionId, override }`); otherwise it is derived
  from the Session's *original* workspace root as `<cwd>/.dsh/devlead/board.json`. A deployment
  Config `boardPath` still wins as a host-wide override, but a page loaded before the lead existed
  needs a refresh to see it. Turning mode off or switching to a non-lead Session disposes every
  board registration and closes the on-screen Session's lingering board tab, so the panel never
  keeps reading a previous lead's file. The required services follow the default Web composition,
  and this package has no runtime dependency on the Host package.

The browser bundle only registers into DSH client slots and sends `/devlead` commands from the
toolbar toggle. It has no custom Remote API, no optimistic state flips, and no direct Host access;
DevLead mode state comes from projections, while the board uses DSH's existing read-only Workspace
Files Remote and Workspace/Session catalogs. The locale namespace is
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
侧边栏激活 lead 的强调色行环（无行尾图标）与已关注会话的弱化准星；只读 `devLead`/`devLeadMode`/
`devLeadWatch` projection 并发送 `/devlead` 命令。看板默认开启，但只属于「当前屏幕上的合规 lead」
（top-level Session 且 summary 里 DevLead 模式开启）：只有这时才注册右侧栏只读项目看板 tab、
guide 卡片、标题与 Session 头部按钮（头部按钮本身静态注册，其他 Session 下不渲染）。看板严格
校验 schema v1、跟随文件变更、分组展示项目与任务，并从未看板 workspace 的 Host 投影生成折叠清单。
路径优先取 Host global `__DSH_DEVLEAD_BOARD__`（新 Host 带 `leadSessionId` 与 `override`），否则由
Session 原始 workspace root 派生 `<cwd>/.dsh/devlead/board.json`；配置 `boardPath` 仍是部署级覆盖，
但页面若在 lead 出现之前加载，需要刷新才能看到覆盖路径。模式关闭或切换到非 lead Session 会注销全部
看板注册并关闭当前 Session 遗留的看板 tab，绝不继续读上一个 lead 的文件。所需服务由默认 Web 组合
提供，本包不依赖 Host 包运行期代码。
0.2.0 起样式注入用跨模块实例引用计数（HMR 新旧实例交替不误删标签），组件与准入 hook 用
`react-test-renderer` 做渲染测试。已知 mark 回填与 blank 行限制见根 README。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
