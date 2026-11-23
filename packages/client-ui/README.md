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
  groups/sorts project cards, and exposes only refresh/disclosure controls. The page reads the
  board file directly through the Workspace Files Remote: the schema's 256 KiB file cap applies and
  the model tool's separate 64 KiB read cap does not. A not-yet-existing file is not an error, and
  the decoder is the same protocol schema implementation the Host validates with (the browser uses
  DSH's frozen `zod` platform singleton; no extra runtime dependency). A restored right-Sidebar
  board tab whose on-screen Session is no longer an eligible lead is closed on the first sync even
  when this page instance never registered the board surfaces. A collapsed section joins the
  authoritative Workspace/Session projections to show registered Workspaces absent from the board.
  The path comes from the Host global `__DSH_DEVLEAD_BOARD__` when it names this lead
  (`{ boardPath, schemaVersion, pathPlatform, leadSessionId, override }`); otherwise it is derived
  from the Session's *original* workspace root as `<cwd>/.dsh/devlead/board.json`. A deployment
  Config `boardPath` still wins as a host-wide override, but a page loaded before the lead existed
  needs a refresh to see it. Turning mode off or switching to a non-lead Session disposes every
  board registration and closes the on-screen Session's lingering board tab, so the panel never
  keeps reading a previous lead's file. The required services follow the default Web composition,
  and this package has no runtime dependency on the Host package.

  Automatic refresh retains the 120 ms change debounce and polls **every** file state: ready/loading
  use a fixed 5 s cadence by default, while empty/error back off exponentially from 5 s to a 30 s
  ceiling. Timers run only while the document is visible and focused. Visibility/focus resume
  triggers an immediate coalesced read; blur, hidden, unmount, and path changes clear timers. Watch,
  poll, and resume triggers share one in-flight read. A watch ready/change received during that read schedules
  at most one trailing refresh; poll/focus triggers only coalesce, so later changes are neither duplicated nor dropped. Manual refresh can still force a fresh read
  and reconnect the watch; an ended watch never reconnects silently, but polling continues. The
  redesigned header shows active/blocked/paused/done KPIs, revision/updated time, and Live refresh
  health. Blocked projects lead with a strong warning; active cards use a responsive two-column
  main area (one column when narrow), with focus/next/blockers and task progress. Paused/done and
  unlisted projects are secondary disclosures. Light/dark styling, aria labelling, keyboard-native
  disclosures, and read-only operation are part of the browser acceptance checklist.

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
面板直接经 Workspace Files Remote 读取看板文件（schema 的 256 KiB 文件上限；模型工具另有的
64 KiB 读取裁剪不作用于面板），解码器与 Host 共用同一份 protocol schema（浏览器侧 `zod` 来自 DSH
冻结 module table，无额外运行期依赖）。恢复出来但当前 on-screen Session 已非合规 lead 的 board tab
会在首次 sync 时被关闭（即使本页从未注册过看板 surface）。
路径优先取 Host global `__DSH_DEVLEAD_BOARD__`（新 Host 带 `leadSessionId` 与 `override`），否则由
Session 原始 workspace root 派生 `<cwd>/.dsh/devlead/board.json`；配置 `boardPath` 仍是部署级覆盖，
但页面若在 lead 出现之前加载，需要刷新才能看到覆盖路径。模式关闭或切换到非 lead Session 会注销全部
看板注册并关闭当前 Session 遗留的看板 tab，绝不继续读上一个 lead 的文件。所需服务由默认 Web 组合
提供，本包不依赖 Host 包运行期代码。

自动刷新保留 120ms change debounce，并覆盖**所有**文件状态：ready/loading 默认固定 5s 一轮，
empty/error 从 5s 起指数退避到 30s 上限。只有 document visible 且 focused 时才运行 timer；
visibility/focus 恢复立即 coalesced read，blur/hidden/unmount/path change 清理 timer；watch、poll 与
恢复触发共享 in-flight 读取；在途期间新到的 watch ready/change 合并为一次 trailing refresh（poll/focus
只共享当前读取），避免叠发或丢失后续 change。
手动刷新仍可强制重读并重连 watch；watch ended 不静默重连，但轮询
继续。重做后的顶部显示 active/blocked/paused/done KPI、revision/updated 与 Live 自动状态；blocked
强警示置顶，active 主区响应式 2 列（窄栏 1 列），卡片含 focus/next/blocker 与任务进度，paused/done/
unlisted 为次级折叠。light/dark、aria、键盘 disclosure 与只读行为均纳入浏览器人工验收。
0.2.0 起样式注入用跨模块实例引用计数（HMR 新旧实例交替不误删标签），组件与准入 hook 用
`react-test-renderer` 做渲染测试。已知 mark 回填与 blank 行限制见根 README。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
