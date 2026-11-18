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

6. 清理：

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
