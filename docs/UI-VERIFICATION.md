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
4. **项目卡片**：准备含四种状态、不同 priority/updatedAt 的 schema v1 文件；blocked 组与顶部提示优先，
   同组排序正确；focus/next/blocker since、任务 done/total、展开任务与截断 owner id 均可读，没有编辑控件。
   面板**直接读取看板文件**并按 schema v1 解码（文件上限 256 KiB），不受工具层 64 KiB 裁剪影响；
   贴满一次工具读取上限的 64 KiB 内容也应完整显示，模型工具结果里的 `truncated:true` 不该出现在面板。
   `devlead_board_read` 的 64 KiB 上限只约束**工具返回给模型的结果**（按 tasks → blockers → project
   行从尾部裁剪并标 `truncated:true`），不是右栏面板的行为。
5. **文件状态**：文件不存在显示「还没有看板数据」而非错误，并保持页面打开——Host 首次写入创建
   文件后应由 change 或空态有界轮询（4s 起、退避到 30s）自动出现，无需手动刷新；坏 JSON/schema
   显示「看板文件解析失败」、最后成功时间和重试；改回合法文件后 change 触发自动恢复，手动刷新也
   可恢复。watch 断开时显示「自动更新已断开，请手动刷新」警告而非“正常”，手动刷新会同时重连
   （不会静默自动重连）。
6. **其余项目**：折叠区只列未出现在 board 的已注册 workspace，名称/path、会话数与最近 Session 活动正确；
   无活动、全部已列出、清单 pending/error 不编造内容；清单同时处于 pending 与 error 时显示错误而不是
   「正在读取」。多个面板实例（例如快速开关 tab 后残留的旧实例）的组标题 DOM id 不得冲突。
7. **布局与主题**：右栏拉窄及桌面窄屏时长路径、自由文本和任务标题均换行，不出现横向溢出；light/dark
   下 pill/tag、warning/error、refresh/empty 状态可辨，刷新与重试按钮保持可用。

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
