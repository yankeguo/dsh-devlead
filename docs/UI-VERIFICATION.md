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
   - 侧栏：active lead 行只有右上角 sparkle + `LEAD` 小角标，无整行 ring/选中态改变；被关注行有
     弱化准星；搜索态与 blank 行没有这些标记。
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
3. **Config override + late enable 需要刷新**：如测试 `boardPath` override，先把 profile 配置为
   `.dsh/devlead/board.json` 或 `custom/board.json` 等相对路径再启动；Host 相对 active lead 的原始
   workspace 根 `SessionHeader.cwd`（不是 worktree checkout）解析，override 同样要求该根存在且不重建。
   若页面在 lead 启用前已加载，late-enable 场景必须刷新页面才能读到解析后的 override 路径与
   `override:true` 的 global（这是预期行为，不是 bug；默认路径不需要刷新）。另验证绝对 POSIX、Windows
   盘符/UNC 在 Loader/直接构造时以 `BOARD_INVALID` fail-fast，错误提示改用相对路径；反斜杠、空段与
   `..` 逃逸同样被拒绝，`path.resolve` 后仍在根内且最终组件不能是 symlink。既有绝对路径配置必须迁移后才能启动。
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
   调用；metadata 应更新，但当前 note 的 watch 不重建，stat/readBytes 次数不增加。rc.7 起 bytes 也不再作为
   正文代际 key（它可能尚未对账），正文只由自身 watch/poll + live stat/readBytes 驱动；不能把这项优化误测成
   停止正文自动刷新。
3. **视觉 busy 与读屏分离**：开启读屏软件观察至少 3 个 5s 周期；视觉上「正在刷新/自动刷新」可以变化，
   polite live region 不得每轮重复播报。切换 paused/active、watch ended 或出现错误时仍应有对应状态迁移/错误
   提示，刷新按钮的 `aria-busy` 保持可用。
4. **边界错误局部恢复**：非法 UTF-8 的 index/note 即使字节数不变也必须显示局部解析错误；超限正文在模型
   工具结果中是 `truncated:true` 的 64 KiB 有界 JSON，而浏览器仍按完整文件读取。大小写变体与 Windows 保留名
   由共享 schema/Host/client 自动化覆盖，不要求在大小写不敏感主机上手工制造冲突文件。

### 0.4.2-rc.7 必查：原生正文编辑与 live reader

本轮 notes 索引仍由 Host 工具维护，但正文改由 agent 通过 DSH 原生 read/write/edit 直接修改。沿用全新隔离
profile，不以单测代替真实浏览器观察：

1. **原生编辑自动刷新**：用 `devlead_board_note_write create` 创建 note，从返回结果记录 `absolutePath`，
   不调用 update/append（工具面已移除），直接通过原生文件编辑修改该 md。保持 reader 打开且不点手动刷新，
   watch change 后正文与标题栏 live 时间应更新；watch ended 时由可见且聚焦页面的 poll 恢复。read/list 后
   index bytes/updatedAt 已对账，磁盘正文仍是原生编辑内容。
2. **live 时间的含义与隔离**：reader 标题栏优先显示当前 ready 文件成功 `stat` 的观察时间；DSH
   `WorkspaceFileStat.version` 是 opaque token，不能当 mtime 解析。index 的 title/summary/updatedAt/bytes
   刷新不得重建正文 watch 或增加正文 I/O；note list 排序/时间和项目 chip 最新标题仍只看 index，不能借用
   另一 note 的 live 时间。path/note 切换期间不得显示旧正文或旧 live 时间。
3. **旧 index 与错误降级**：在 Host 尚未 read/list 对账时，index bytes/updatedAt 旧值不得导致 reader 报错、
   停止轮询或展示旧正文。分别直接制造缺文件、超过 256 KiB、非法 UTF-8：Host read/list 返回结构化错误且
   index 不变；UI 仅当前 reader 或 notes 区降级，board 卡片/KPI/chip 与原 watch/poll 不回归。修复文件后
   自动恢复，delete 仍能清理缺失/非法正文的 index entry。
4. **notes chip / reader 回归**：light/dark 与宽/窄栏复查 notes chip/count/latest、全栏 Markdown reader、
   返回焦点、危险载荷文本化与只读性。保存本轮真实截图和带时间戳的原生文件写入 + Remote stat/readBytes
   记录；仅有组件测试或旧 rc.4/rc.5 截图时不得把本轮人工验收标为通过。

### 0.4.2-rc.8 必查：入口、blocked 恢复、KPI 与 status 卡片

本轮沿用全新隔离 profile 和真实 Chrome，不以组件测试或旧截图替代。准备 active（high/low 各一）、blocked、
paused、done 项目，先以 active revision 打开面板，再让一次自动 stat 永不 settle、外部把同一项目改为 blocked，
随后恢复 Remote；不点手动刷新确认 watchdog 后卡片、blocked 分组、banner、KPI 和 revision 一起更新。

1. **入口与窄栏元信息**：会话头部和 guide 都是仪表盘图标；按钮保持 28×28，glyph 18px，与相邻 utilities
   协调且不偏小。tooltip/aria-label 中英文均明确「打开项目看板 / Open project board」，lead-only gating
   不回归。Live 标签肉眼可见，长刷新状态在独立文本 lane ellipsis；revision、updated 不重叠，极窄栏四个
   KPI 可在 strip 内横向访问而页面不横溢；strip 本身可聚焦并有可见焦点，键盘左右键可读到第四项。
2. **KPI 层级**：固定 blocked → active → paused → done，状态图标和文字同时存在；零值统一中性边框/
   tertiary 文字（不用低 opacity 损害对比度），非零数字清楚。只有 blocked>0 使用 warning 强底色/描边，
   blocked=0 时 warning 和 banner 都退出。自动刷新后 KPI 与 groups/banner 同源同 revision，不出现 blocked
   项目已显示而 KPI=0；只有 blockers 但 status=active 的负控不计 blocked。
3. **四态四边卡片**：所有卡片都是完整四边同宽边框 + 轻底色，不再有 `::before` 单左边色条，也不再有
   `[data-priority]` 卡片着色规则。高/低 priority 的 active 卡片 computed `border-top/right/bottom/left-color`
   与 background 完全一致；priority 只读独立 badge。hover/focus 不得把其它 status 的边框改成 active 蓝。
4. **固定颜色 token 映射**：active 使用 `--dsw-alias-state-business-primary`；blocked 使用
   `--dsw-alias-state-warn-primary`；paused 使用 neutral `--dsw-alias-label-secondary`；done 使用
   `--dsw-alias-state-success-primary`。blocked KPI、banner、卡片边框必须是同一个 warning token；
   light/dark 各检查四态边框、底色、文字、图标和 focus 对比度，状态不能只靠颜色区分。
5. **证据**：保存 light/dark 的四态全景、active high/low 对照、blocked>0 与 blocked=0、240–340px 窄栏、
   header tooltip/focus，以及 hung-stat 恢复前后截图/带时间戳 Remote 记录。真实 computed style 记录四边
   颜色；仅有渲染属性、CSS 文本断言或旧 rc 截图时不得标记本轮视觉验收通过。
6. **lead 角标与选中态隔离**：分别选择 lead 行和另一个普通 Session 行，active lead 未选中时只在右上角
   显示 sparkle + `LEAD` 小角标，无四边 ring、背景或发光；lead 被选中时仅呈现 shell 原生选中/hover/focus
   样式，角标不与它混成第二重选中框。普通非 lead 行无角标，watched 准星保持弱化。检查角标原生 title/
   aria-label 中英文、窄栏和 light/dark 可读性；保存「lead 未选中」与「lead 选中」对照截图和 computed
   row border/background/box-shadow 记录，确认没有任何 `[data-devlead-active-mark]::after` 复用。

### 0.4.2-rc.9 必查：内联角标与 focus 下 lead 说明

本轮针对 rc.8 复核发现的遮挡与可访问性退化，仍需真实 Chrome 截图和几何记录，不能只跑样式字符串断言：

1. **time/badge/actions 不重叠**：lead 选中、未选中各查 light/dark；把左侧栏实际拖到 shell 最小的
   264px。resting 状态下角标必须是 trailing seat 内 time 后面的普通 flex 子项，computed
   `position=static`，time/badge 矩形不相交；hover 或键盘 focus 时整个 resting seat 由 shell 隐藏、独立
   actions 显示，不允许插件把角标绝对定位到 actions 上。触屏 `hover:none` 若工具支持模拟，需另外保存
   time/badge/actions 的几何与截图；若不支持，必须明确写「未模拟」，不能用桌面 hover 结果冒充。
2. **hover/focus 的可访问 lead 事实**：hover lead 行、等待 hover card，再只用键盘让该行 `:focus-within`。
   两种状态下 `[data-devlead-row-accessible="lead"]` 的中文/英文完整说明都必须仍在 leading seat，computed
   样式是 visually-hidden 而不是 `display:none`；hover card 内另有 `[data-devlead-row-hover]` 可见说明。
   保存 hover 与键盘 focus 截图及文本/computed 记录。无需操作系统读屏器时，结论只限 DOM/aria/AX 文本，
   不声称完成读屏软件验收。
3. **shell 限制不得隐瞒**：Session 的高优先级状态点会替换 leading seat，此刻常驻 visually-hidden lead
   文本不存在，hover card 只是补充；blank 行与搜索结果行仍无标记。这些限制写入 DESIGN 与 release notes，
   不把「hover/focus 修复」扩大成「所有状态都有常驻 AX 文本」。
4. **P4 同步检查**：watchdog 超时必须先断言 `error/read` 再验证 abort 后恢复；新增 hung `readBytes`、全 0
   KPI 与 guide icon 的自动化回归。guide 的带描述卡片图标遵循 shell 实际 26px 契约，Session header
   按钮仍是 18px glyph / 28×28 按钮，二者不要混写。

### 0.4.2-rc.10 必查：同行内部对齐、priority 图标与紧凑 header

本轮只微调项目看板，仍需全新隔离 profile 的真实 Chromium 前后截图和几何记录，不以组件断言代替视觉结论。
准备同一 active 组内 high/medium/low 各一张卡，混合长短标题、focus/next/goal、可选 blocker 与 notes chip：

1. **十条同行轨道**：同一视觉行卡片等高，title/workspace/meta/focus/next/goal/blockers/progress/tasks/footer
   对应 DOMRect 的 y 一致。focus 最多 3 行、next/goal 最多 2 行，短文本与空 goal 不让后续轨道塌陷；全文仍可
   通过原生 title 或展开任务 disclosure 阅读。记录每张卡高度及 progress/tasks/footer 的 y；再展开其中一张任务，
   确认共享轨道扩大时同行 footer 不错位。不支持 subgrid 的降级只承诺卡片等高与 footer 贴底。
2. **标题行 priority**：high/medium/low 同排分别显示双上箭头、单上箭头、下单箭头，不只靠颜色区分；图标固定
   最右且右边缘按列对齐，长标题 ellipsis、窄栏不挤掉图标。正文 badges 不再有 priority 文字，notes chip/count/
   latest 保留。hover 有本地化 tooltip，`role=img` 与 aria-label 分别为「高/中/低优先级」（英文同步）；light/dark
   均可辨，卡片四边 status 色不受 priority 影响。
3. **卡片状态点边界**：卡片标题左侧不再渲染 `StateDot`，active 卡片没有 spinner；状态仍由分组标题、KPI 与
   status 边框/底色表达。**不要误删** LIVE 的状态点或手动刷新按钮 `aria-busy` 的 IconRefresh 旋转；点击刷新时
   按钮仍 disabled、状态文本与 live-region 行为不变，轮询/watch 不受影响。
4. **单行面板 header**：右侧 tab 标题保持「项目看板」，面板内不再显示重复 h3 或「只读」Tag；根容器有本地化
   aria-label。header 左侧是 LIVE 圆点/标签/状态，右侧是 updated 相对时间、rN 与最右刷新按钮，KPI 紧随其后。
   宽栏两侧 space-between；240–340px 窄栏允许优雅换行/收缩但无横向溢出，刷新始终可达且位于 actions 末端。
5. **证据组合**：保存同一 fixture 的 rc.9 改动前与 rc.10 改动后 wide/dark 对照，另存 rc.10 wide/light、
   三档 priority 同排、窄栏 light/dark、priority hover tooltip、刷新中静态/旋转边界（卡片无 spinner、刷新按钮
   保留）及任务展开图。记录 console error、横向 overflow、priority ARIA、卡片边框 computed style 和十轨几何；
   不得用旧 rc 截图或 DOM 属性冒充本轮真实视觉通过。

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
