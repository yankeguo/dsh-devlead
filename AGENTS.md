# AGENTS.md — dsh-devlead 仓库工作约定

本文件面向在本仓库工作的 agent。用户文档见 [README](README.md)（[中文](README.zh.md)）；
开发环境、构建/测试/E2E 见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)，架构与实现细节见
[docs/DESIGN.md](docs/DESIGN.md)，发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)，DSH
兼容面见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。这里只记跨任务复用的约定和门禁，不复述细节。

## 仓库与验证

- 6 个可发布包的 pnpm workspace：protocol → client-ui → devlead → command → tool → bundle。
  所有包同版本，依赖先发布、bundle 最后。
- 改动后的最低门禁是 `pnpm verify`（typecheck + test + build）。改动包边界、导出或
  `dsh.client.inject` 时再跑 `pnpm check:packages`；改动 Session、命令、projection、
  通知或浏览器加载路径时再跑 `pnpm e2e`（本地真实 DSH，CI 不含）。
- 行为变化要同步更新 `README.md` 与 `README.zh.md` 的对应段落；架构、发布、兼容性分别落在
  `docs/` 下已有的文件里，不新开平行说明。
- 浏览器端的视觉行为不能只靠单测判断，按
  [docs/UI-VERIFICATION.md](docs/UI-VERIFICATION.md) 在隔离 profile 里验收。

## DSH 源码核对

- 本机只读源码克隆 `/Users/guoyk/Workspace/src/deepseek-harness` 必须始终跟踪最新
  `master`：可以 `git fetch --all --tags` + `git pull --ff-only` 更新到最新，但不要把主
  checkout 切到旧 tag/分支，也不要在其中修改源码。
- 核对特定版本（如 `dsh-v0.2.2-rc.1` – `dsh-v0.2.2-rc.5`）的实现差异时，用
  `git worktree add <独立目录> <tag>` 检出到仓库外的独立目录查阅；用完执行
  `git worktree remove <独立目录>` 清理，不要用 checkout/switch 污染主 clone。
- 运行行为以本机安装版 DSH 为准；安装版与源码 `master` 有版本差异时，在交付说明中注明
  实际版本，并说明兼容结论的依据。

## 发布纪律（硬门禁）

- **没有人类明确指示，不 push、不打 tag、不 stage/approve、不创建 GitHub Release。**
- 发布固定为 stage → 人工 approve → GitHub Release 三段；tag 一旦推送就**不移动、不删除、
  不重建**。
- approve 后必须做三方核对：6 个包的 `@<version>`、npm `dist-tags`、GitHub Release 指向
  同一个 tag 和 commit。缺 GitHub Release 时用既有 tag + `docs/releases/v<version>.md`
  补建（`gh release create ... --verify-tag`），不要重建 tag。
- 发布细节与故障处理以 [docs/PUBLISHING.md](docs/PUBLISHING.md) 为准。

## DevLead 子会话

- 创建子 Session 时默认显式传 `preset: "standard"`。本机 desktop profile 的默认 preset 是
  `ptc`（为 Computer Use 插件保留）；只有任务明确需要 PTC / Computer Use 时才用 `ptc`，
  不要改 profile 的默认值。
- 先 `devlead_list_agent_presets` 确认 Host 的真实 roster，不要假设 preset id。

## UI 约定（不要回退）

- `DevLeadBar` 只读：显示关注/运行计数和最新通知，不承载模式开关。
- 唯一的模式开关是 composer 工具栏的 `DevLeadIconToggle`，top-level Session 的两种状态都
  渲染；关闭模式后开关仍在原位，不能随状态条一起消失。subagent Session 例外：它不可能升格
  为 DevLead，`DevLeadIconToggle` 与 `DevLeadBar` 都不渲染。
- 侧栏 active lead 行只画 CSS overlay ring，不加行尾图标；watched 行用弱化的准星标记。
  不要给 Session 行加 border / padding / height（shell 行只有左右 transparent border）。
- 搜索态结果行和 blank 行没有 trailing seat，因此不显示 active/watched 标记；这是 shell
  限制，不是 bug。
- 细节与根因见 [docs/DESIGN.md](docs/DESIGN.md) §7。

## 记忆来源

本文件与 `docs/UI-VERIFICATION.md` 于 2026-11-19 从已卸载的 DSH 记忆插件残留中整理，
只保留可复用的工作约定；不含原始 session 日志、密钥、token 或一次性发布状态。
