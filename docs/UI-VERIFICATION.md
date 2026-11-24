# 客户端 UI 可视验收（隔离 profile）

用于人工检查 composer 开关、`DevLeadBar`、侧栏 active/watched 标记等浏览器视觉行为。
自动化断言走 `pnpm e2e`；本流程只补截图、布局与交互层面的验收。

## 原则

- **不要改正在运行的 desktop profile**：那里装的是 npm 版插件，不是本仓库的构建产物。
- 每次都用全新的临时 `DSH_HOME` 与专用 profile；临时 home 里有凭据副本，结束必须删除。
- 带 token 的启动 URL 只在本机浏览器打开，不要写进文档、提交或聊天记录。

## 步骤

1. 构建本仓库：

   ```sh
   pnpm build
   ```

2. 建临时 home 与专用 profile（`web` 是 DSH 自带的模板，不是本插件的 bundle）：

   ```sh
   TMP_DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-devlead-ui.XXXXXX")"
   # 可选：让实例具备本机凭据；不存在则跳过（视觉验收本身不调用模型）
   [ -f ~/.dsh/.credentials.yaml ] && cp ~/.dsh/.credentials.yaml "$TMP_DSH_HOME/.credentials.yaml"
   DSH_HOME="$TMP_DSH_HOME" dsh devlead-ui --from-default-profile web --dump-config
   ```

3. 生成 overlay，并把这个 checkout 注册为该 profile 的 linked root：

   ```sh
   node scripts/dev-patch.mjs --profile devlead-ui --dsh-home "$TMP_DSH_HOME"
   ```

4. 启动隔离实例（用启动输出里带 token 的 URL 打开浏览器）：

   ```sh
   DSH_HOME="$TMP_DSH_HOME" dsh --profile devlead-ui \
     --patch "$PWD/.tmp/cordis.patch.yml" --no-open --port 34000
   ```

5. 验收要点：

   - 新建一个**空会话**即可执行 `/devlead on`（命令路径不调用模型，不需要 provider 凭据）。
   - 关闭态：composer 工具栏只有 DevLead 图标 + 文本按钮。
   - 开启态：composer 上方出现只读 `DevLeadBar`；工具栏开关仍在原位，点击发送
     `/devlead off`。
   - 侧栏：active lead 行有 accent ring、无行尾图标；被关注行有弱化准星；搜索态与 blank
     行没有这些标记。
   - 如需真实 watch/通知，再建一个会话并 watch，然后触发一次 turn 结束。

### 0.4.0 视觉验收项（发布前必查，对应 PUBLISHING checklist (d)）

以下 4 项是 0.4.0（由 0.4.0-rc.1 引入）新增/变更的浏览器视觉行为，必须在隔离 profile 里逐项确认；`pnpm e2e`
只断言 projection/DOM/渲染，不能替代人工判断。

1. **三 lane 配色**：让状态条显示 `turn-notice`（completed/forked）、`action-required`
   （blocked/decision/question）与 `background`（progress/fyi）三类最近通知。`action-required`
   的 kind label 应使用 warning 色的文字（与 blocked 圆点同色系）、`background` 整条 chip 更弱
   （不透明度降低）、`turn-notice` 保持中性色；颜色只影响文字/圆点，不改变行高、间距或换行。
2. **question 状态**：watch 一个子会话并触发真实 `ask_user_question`（或 e2e 的 scripted
   child），DevLeadBar 的 question report 行显示生命周期后缀：`open` 为「待回答」，lead 回答后
   fold 派生为「已回答」，answer 再按 admitted/claimed/presented 显示「已接收/已认领/已呈现」；
   刷新页面后旧状态不得残留或回退。
3. **`provisional` /「暂定」**：当 question report 的 `repairPending:true` 时，状态后缀追加
   「暂定」（如 `open · provisional`），表示 fold 的 question/answer 状态尚未被 durable repair
   证明；repair settle 后标记消失。确认标记不改变 strip 的只读语义（strip 不承载开关、不发命令）。
4. **状态条布局**：把窗口收窄（如 720px）后，DevLeadBar 仍单行显示品牌、watched/running 计数、
   最新通知与 question 后缀；长 session 标题/长 question 文案以 ellipsis 截断，不撑高 composer
   dock、不产生横向滚动；关闭态与 subagent Session 不渲染 strip，开关仍留在 composer 工具栏原位。

### Step B 项目看板验收项

看板默认启用、无需配置：active lead Session 原始 workspace 根下的
`<cwd>/.dsh/devlead/board.json` 就是看板文件（`SessionHeader.cwd`，不是 worktree 检出）。
在隔离 profile 里新建 lead 会话、执行 `/devlead on`，按以下顺序检查：

1. **lead-only 开关与入口**：任何 Session 在关闭态都没有看板按钮/tab/guide 入口；在 lead 执行
   `/devlead on` 后，会话头出现图标按钮、guide 出现入口，右侧栏 tab `devlead-board` 可打开，
   同一 pane 重复点击复用页面。切换到普通（非 lead）Session 时没有这些入口；切回 lead 后重新
   出现。`/devlead off` 后入口消失、已打开的面板被 dispose，且不再读取旧文件。
2. **默认路径派生**：确认文件落在 lead 的原始 workspace 根下（例如 scratch workspace 的
   `<workspace>/.dsh/devlead/board.json`），而不是 worktree/effective cwd；在 lead 刚开启后让 AI 调一次
   `devlead_board_update` 写入，面板应出现项目卡片。**先加载页面、后开启 lead** 的场景：默认路径
   部署不刷新页面也应出现入口（client 从 lead Session summary 的 `cwd` 自行派生路径）。
   Host 在派生默认路径前要求 lead 的原始 workspace 根**仍是已存在目录**：把该目录删除/移走后，
   Host 侧看板保持 disabled（不 `mkdir` 重建、不写入，工具报 `BOARD_DISABLED`，`boardDisabledReason =
   missing-workspace`）；页面在 self-heal 下仍可能显示入口并读到空态/读取错误，这是只读读取，
   不得在磁盘上重新创建该 workspace 目录。
3. **Config override + late enable 需要刷新**：如测试 `boardPath` override，先改 profile 配置再
   启动；若页面在 lead 启用前已加载，late-enable 场景必须刷新页面才能读到 override 路径与
   `override:true` 的 global（这是预期行为，不是 bug；默认路径不需要刷新）。
4. **顶部与项目卡片**：准备含四种状态、不同 priority/updatedAt 的 schema v1 文件；顶部
   active/blocked/paused/done KPI 数量、revision、updated 相对时间与 Live 自动状态正确。blocked
   强警示与项目组置顶，active 位于主区；宽右栏为响应式 2 列、窄栏降为 1 列，同组排序正确。
   focus/next/blocker since、任务 done/total 进度条、展开任务与截断 owner id 均可读；paused/done
   是次级折叠，且没有编辑控件。面板**直接读取看板文件**并按 schema v1 解码（文件上限 256 KiB），
   不受工具层 64 KiB 裁剪影响；贴满一次工具读取上限的 64 KiB 内容也应完整显示，模型工具结果里的
   `truncated:true` 不该出现在面板。`devlead_board_read` 的 64 KiB 上限只约束**工具返回给模型的
   结果**（按 tasks → blockers → project 行从尾部裁剪并标 `truncated:true`），不是右栏面板的行为。
5. **文件状态与自动刷新**：文件不存在显示「还没有看板数据」而非错误；坏 JSON/schema 显示
   「看板文件解析失败」、最后成功时间和重试。watch change 仍在 120ms debounce 后触发重读；与此同时
   **所有状态都有轮询**，不是只有 empty 才轮询。按下面逐项留存带时间戳的 Remote 调用记录/录屏、
   文件写入时间与 revision/内容变化，不能只凭“最后更新了”判通过：
   - **节奏**：ready/loading 连续至少 3 个周期均为默认 5s 固定节奏，不退化成 10s；empty 与 error
     分别记录 5s → 10s → 20s → 30s → 30s 的实际 tick。empty 首次写入、error 修复为合法文件后均
     能由 change 或下一轮 poll 自动恢复，无需手动刷新。
   - **隐藏暂停与恢复**：页面 hidden 或 window blur 后 Live 显示自动刷新暂停；等待超过 30s 应没有
     poll。恢复 visible + focused 时立即发生一次读取；同时到达的 visibilitychange/focus 与 watch/poll
     在途期间新到的 watch ready/change 应合并为一次 trailing refresh（poll/focus 只共享当前读取），不叠发也不丢后续 change。记录隐藏前后、恢复前后的调用次数；另确认
     unmount/path change 后旧 timer 不再读旧路径。
   - **watch ended**：让 change stream 断开，警告应明确「文件监听断开，自动轮询仍开启」（页面活跃时），
     不得再写「请手动刷新」作为唯一恢复路径。随后外部修改文件且不点刷新，下一固定/退避 tick 仍应
     读到新 revision；watch 不得静默自动重连。手动刷新仍可强制重读并重连 watch。
6. **其余项目**：次级折叠区只列未出现在 board 的已注册 workspace，名称/path、会话数与最近 Session
   活动正确；无活动、全部已列出、清单 pending/error 不编造内容；清单同时处于 pending 与 error 时显示
   错误而不是「正在读取」。多个面板实例（例如快速开关 tab 后残留的旧实例）的组标题 DOM id 不得冲突。
7. **布局、主题与可访问性**：container 已上移到 `.devlead-board` 根，header KPI 与 cards 都应按**右栏
   container 宽度**（不是只看 viewport）响应；右栏拉窄时主区从 2 列降为 1 列。长路径/自由文本/任务标题
   按设计以 ellipsis/line-clamp 截断，原生 `title` 可读全文，且不得出现横向溢出；light/dark 下 KPI、
   pill/tag、blocked 强警示、warning/error、loading/empty 与 Live active/paused 状态可辨。只用键盘即可
   操作刷新、paused/done/unlisted 与任务 disclosure，焦点可见；检查标题关联、状态 live region、任务进度
   aria 值及按钮名称。全程只读，刷新与重试按钮保持可用。

以上自动刷新证据与视觉走查均为**发布前人工浏览器验收项**：fake-timer 单测、渲染断言和 `pnpm e2e`
不能证明真实 document focus/visibility、实际 5s/退避节奏、watch 断开后的持续轮询、响应式布局或
light/dark 对比度，因此不能替代本节的隔离 profile 人工验收。未逐项留存证据前不得标记为已通过。

### 0.4.2-rc.4 必查：紧凑看板与项目 notes

本轮仍使用上面的全新隔离 profile，不以组件测试、DOM 断言或旧候选截图代替真实浏览器走查。准备至少
active / blocked / paused / done 各一个项目；active 项目要有长短标题、长 workspace path、focus/next、
blocker、任务进度与多条 notes，另准备一个完全没有 notes 的项目。逐项确认：

1. **无冗余标签与紧凑信息层级**：卡片正文不重复显示肉眼可见的 `Workspace` / `Focus` / `Next` /
   `Blockers` / `Tasks` 等 field label；字段含义由位置、图标、内容排版和无障碍名称表达。不得为了去标签
   而删掉 workspace、focus/next、blocker since、任务 done/total、priority/status、updatedAt 等信息。
   图标按钮和不自明图标都有 tooltip 与可访问名称，全文仍可通过原生 `title`、disclosure 或 reader 阅读。
   展开原生任务 disclosure 时必须同时解除 focus/next/goal/blocker/task 的 line-clamp，触控和键盘用户不能
   只能依赖 hover 才能读全；卡片不应另有一个语义重复的伪按钮展开入口。
2. **KPI 与卡片密度**：active/blocked/paused/done KPI 是**单行 pill strip**，不是四张独立大卡片；
   数量与状态可辨且不挤成多行；极窄栏允许 pill strip 自身横向滚动，但页面/卡片不得横向溢出。
   revision、updated、Live/refresh 状态保持可读但不抢占主内容。卡片间距、
   标题、元信息、正文与任务 disclosure 有清楚的焦点层级；键盘焦点、当前展开区和 blocked 警示不能只靠
   颜色区分。长内容不造成意外换行、遮挡或横向滚动。
3. **blocked 与响应式列**：blocked 项目继续以强警示置顶，其 blocker 内容完整可达，不能在紧凑化后弱化
   成普通 active 卡片。调整**右栏 container 宽度**（同时补测 viewport）确认宽栏 2 列、更宽栏 3 列、
   窄栏 1 列；列数变化不丢卡片、不改变项目顺序语义，也不把 KPI 撑成多列大卡片。极窄栏下所有操作仍可达。
4. **主题、键盘与 a11y**：light/dark 各完整走查一遍，检查 pill、图标、次级文字、blocked/warning/error、
   empty/loading、notes chip 与 reader 的对比度。只用键盘操作刷新、项目/任务/paused/done/unlisted
   disclosure、notes 列表、打开/关闭 reader 与链接；焦点始终可见，打开 reader 后焦点落点合理，关闭后回到
   触发控件。核对标题关联、按钮名称、状态 live region、任务进度 aria 值与 disclosure 展开状态。
5. **notes chip / count / latest**：有 notes 的项目显示 notes chip、准确 note 数和最近一条标题；最近标题按
   `updatedAt` 选择，长标题截断但全文可达。无 notes 项目、空 index、index 不存在都不伪造 chip/count/latest。
   notes 元信息来自 `dirname(boardPath)/notes/index.json`，正文只在打开对应 note 时读取，index 不包含正文。
6. **全栏只读 reader 与安全 Markdown**：打开 note 后 reader 使用右栏全宽，不被项目卡片网格压成半栏；
   显示标题、摘要/更新时间与正文，返回/关闭后项目上下文仍在。用一份真实 note 覆盖 headings、段落、
   有序/无序列表、blockquote、 fenced code、inline code、bold/italic/strikethrough 与 HTTP(S) link。
   再混入 `<img src=x onerror=alert(1)>`、`<script>…</script>`、`javascript:alert(1)`、`data:text/html,…`
   等载荷：HTML/危险链接必须以**文本**呈现或保持不可点击，不执行脚本、不发起危险导航、不产生 HTML sink；
   reader 不提供编辑控件。
7. **空、加载与错误状态**：分别检查 index 不存在、单 note 不存在、首次加载、Remote read error、坏 UTF-8、
   超限 index/note。加载中不谎称空；空态不报错；单 note 失败只影响该 reader，保留可操作的关闭/重试路径。
   坏 index/坏 note 显示解析错误与可操作的恢复路径，不能把旧正文冒充当前内容。
8. **外部修改自动更新**：不点手动刷新，分别原子改写 index 与**当前打开的** note，记录写入时间、
   revision/metadata 或正文变化和浏览器画面；watch change 后应更新，watch ended 时也由现有可见且聚焦
   页面的 poll 自动恢复。未打开的其它 note 不应被无谓读取。再验证 hidden/blur 暂停、恢复立即 coalesced
   read，以及 lead/path 切换后不再读取旧 index/note。
9. **故障隔离**：坏 index 只让 notes 区降级，坏 note 只让当前 reader 降级；board 的 KPI、项目卡片、
   任务与原有 watch/poll/刷新仍正常。反过来坏 board 不应被 notes 的合法缓存伪装成正常 board。修复坏文件后
   不刷新整页也能通过 change/poll/重试恢复。
10. **真实截图证据**：至少保存 light + dark 各一张 3 列和 2 列全景、一张 1 列窄栏、一张 blocked、
    一张带 notes chip/count/latest 的项目、一张全栏 Markdown reader、一张危险载荷以文本显示的 reader，
    以及空态、index 错误、note 错误各一张。截图须来自本轮隔离 profile 的真实页面，包含足够上下文辨认
    主题、栏宽和状态；自动刷新另附带时间戳的文件写入记录 + Remote 调用/录屏。文件名、日期、对应检查项和
    实际结果由发布证据记录；缺图、仅有旧截图或仅有自动化断言时不得把本轮人工验收标为通过。

### 0.4.2-rc.5 复核加固必查

rc.5 不改变 rc.4 的紧凑 UI 与 notes 功能；以下项目是对上述验收的增量，仍需在隔离 profile 的真实页面检查，
不以单测代替视觉/读屏结论：

1. **打开 reader 切 path**：在一个 workspace 打开 note，保持新 workspace 的首次读取尚未完成时切换 lead/path；
   新路径下不得短暂显示旧 workspace 的 chip、note list、标题或正文。恢复后只读新 index，旧 note watch/timer
   已 dispose，不继续 stat/readBytes。
2. **index-only 更新不增加正文 I/O**：保持 reader 打开，只改 index 的 title/summary/updatedAt，记录 Remote
   调用；metadata 应更新，但当前 note 的 watch 不重建，stat/readBytes 次数不增加。随后改变正文 bytes，当前
   note 才重新读取。正常 note 自身 watch/poll 仍按既有契约工作，不能把这项优化误测成停止正文自动刷新。
3. **视觉 busy 与读屏分离**：开启读屏软件观察至少 3 个 5s 周期；视觉上「正在刷新/自动刷新」可以变化，
   polite live region 不得每轮重复播报。切换 paused/active、watch ended 或出现错误时仍应有对应状态迁移/错误
   提示，刷新按钮的 `aria-busy` 保持可用。
4. **边界错误局部恢复**：非法 UTF-8 的 index/note 即使字节数不变也必须显示局部解析错误；超限正文在模型
   工具结果中是 `truncated:true` 的 64 KiB 有界 JSON，而浏览器仍按完整文件读取。大小写变体与 Windows 保留名
   由共享 schema/Host/client 自动化覆盖，不要求在大小写不敏感主机上手工制造冲突文件。

### 清理

```sh
# 关闭浏览器标签，停止 DSH 进程后：
rm -rf "$TMP_DSH_HOME"
```

`.tmp/` 已在 `.gitignore` 中，overlay 可以保留。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| profile 已启用本 bundle，loader row id 重复 | 每次用新的临时 home + 新的 profile 名；不要复用装过本插件的 profile |
| `gateway/internal: Receiver must be an instance of class Session` | 缺 linked root；重跑 `dev-patch.mjs`，确认 `<profile>/node_modules/devlead-repo` 存在 |
| 端口被占用 | 换一个 `--port` |
| 页面加载不到新 UI | 确认 `pnpm build` 在 `dev-patch` 之前完成，并刷新页面 |
