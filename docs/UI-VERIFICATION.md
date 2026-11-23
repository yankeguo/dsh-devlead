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

在隔离 profile 的 devlead config 中设置一个临时 `boardPath`，刷新页面后检查：

1. **开关与入口**：未配置 global 时没有看板按钮/tab；配置后会话头出现图标按钮，guide 也有入口，
   点击打开 `devlead-board`，同一 pane 重复点击复用页面。
2. **项目卡片**：准备含四种状态、不同 priority/updatedAt 的 schema v1 文件；blocked 组与顶部提示优先，
   同组排序正确；focus/next/blocker since、任务 done/total、展开任务与截断 owner id 均可读，没有编辑控件。
3. **文件状态**：文件不存在显示「还没有看板数据」而非错误；坏 JSON/schema 显示「看板文件解析失败」、
   最后成功时间和重试；改回合法文件后 change 触发自动恢复，手动刷新也可恢复。watch 断开时显示
   警告而非“正常”，手动刷新会同时重连。
4. **其余项目**：折叠区只列未出现在 board 的已注册 workspace，名称/path、会话数与最近 Session 活动正确；
   无活动、全部已列出、清单 pending/error 不编造内容。
5. **布局与主题**：右栏拉窄及桌面窄屏时长路径、自由文本和任务标题均换行，不出现横向溢出；light/dark
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
