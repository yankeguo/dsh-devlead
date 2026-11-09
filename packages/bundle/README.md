---
description: "Dev Lead mode for DeepSeek Harness: turn one session into a lead that creates and steers ordinary Workspaces and Sessions, watches their state, and is woken on change."
kind: "package-bundle"
---

# @yankeguo/dsh-devlead-bundle

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
把**一个普通会话**升级成 **DevLead 会话**，让它能直接操纵 DSH 的 **Workspace** 与
**Session**，创建/续写其他会话、读取会话状态、在会话状态变化时被唤醒，从而在一个
人类可见、可参与的标准界面里统管多个仓库。

## 特性

- **DevLead 模式**：每个会话一个持久开关；打开后获得 8 个 `devlead_*` 工具、DevLead 系统
  提示，以及两态 UI：未开启时只有 composer 工具条小图标，开启后才是 composer 上方的完整状态条。
  开关是**人类专属操作**（`/devlead on|off` 或界面开关），模型无法自行打开。
- **产出物是标准 DSH 实体**：Workspace 真实注册进 `ctx.workspaceRegistry`，子会话是真实普通
  Session（侧边栏可见、可被人类打开接管），**不是 subagent**。
- **监督与唤醒**：被 watch 的会话每个 `turn/end` 都写入 DevLead 会话的持久通知记录，Agent
  存活时经合并窗口唤醒它决定下一步。
- **事件溯源**：模式 / watch 集合 / 通知以可忽略的 `plugin:devlead/*` 记录持久化，可跨重启 /
  恢复 / fork；`devLead` Session projection 把状态同步到浏览器。
- **人类命令**：`/devlead`、`/devlead on|off`、`/devlead watch|unwatch <session>`。
- **两态 UI**：未开启时 composer 工具条里只有一个 ghost 图标（点击 `/devlead on`）；开启后
  composer 上方出现 DevLeadBar，显示开关、监督会话数 / 运行中数与最近通知。

## 本 bundle 包含的插件行

| entry id | 包 | 作用 |
| --- | --- | --- |
| `devlead` | `@yankeguo/dsh-devlead` | 核心服务 `ctx.devLead`：模式、Workspace/Session 编排、通知投递、`devLead` projection |
| `devlead-tool` | `@yankeguo/dsh-tool-devlead` | 8 个模型工具与条件 system prompt |
| `devlead-command` | `@yankeguo/dsh-command-devlead` | `/devlead` 人类命令 |
| `devlead-ui` | `@yankeguo/dsh-client-ui-devlead` | 浏览器两态 UI：工具条开关 + 开启后的 DevLeadBar |

依赖方向：`protocol ← devlead ← {tool, command}`；`client-ui` 只依赖 `protocol`（浏览器侧）。

## 安装

### 从 npm 安装（发布后，推荐）

在 **Plugins → Add plugin** 输入 `@yankeguo/dsh-devlead-bundle` 安装并启用；
或：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

安装后在 Plugins 页面确认 bundle 已启用（新安装的 bundle 通常默认启用；若显示未启用，
勾选一次即可），刷新 Web 页面。升级 / 卸载：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.1.0   # 升级到指定版本
dsh plugin --profile desktop remove @yankeguo/dsh-devlead-bundle     # 卸载
```

### 本地 checkout 安装

```sh
pnpm install && pnpm build
pnpm install:profile            # 链接到 ~/.dsh/profiles/desktop 并启用 bundle
```

或直接 `--patch` 调试（不写 profile，先 `pnpm build`）：

```sh
pnpm build
pnpm dev:patch
dsh web --patch .tmp/cordis.patch.yml --port 34000 --no-open
```

### 前置条件

- DSH `0.2.2-rc.1`（bundle 声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0`）；
- 从 npm 安装不需要本机 Node；本地构建 / 发布需要 Node.js ≥ 24.9 与 pnpm 12。

## 使用

```
/devlead                        # 状态：开关、监督会话、最近通知、帮助
/devlead on                     # 打开当前会话的 DevLead 模式（人类专属）
/devlead off                    # 关闭
/devlead watch <session>        # 监督某个会话（完整 id 或唯一前缀）
/devlead unwatch <session>      # 取消监督
```

打开模式后，让模型为它配置工作区并派发任务：

```
先用 devlead_use_workspace 注册 /absolute/path/to/repo，
再用 devlead_create_session 在这个工作区创建一个子会话，下发下面的任务：……
```

子会话跑完后 DevLead 会话会收到通知摘要并被唤醒。详见仓库 README 的「使用」与
「通知机制」。

## 配置

bundle 的 patch 行没有显式写配置，核心服务使用 DESIGN 默认值；要覆盖时在 profile 的
`cordis.patch.yml` 里按 loader row id `devlead` 覆盖该行 `config`（DSH 的 patch 是整体替换
该行 config，需写全要保留的字段）。

```yaml
- id: devlead
  config:
    notificationBatchMs: 400     # 通知合并窗口（毫秒）
    maxWatchedSessions: 64       # 每个 lead 最多监督的会话数
    maxListedSessions: 200       # 会话列表最大行数
    wakeColdSession: false       # 冷 DevLead 会话是否 resume 后唤醒
    defaultAgentPreset: ''       # 创建会话的默认 Agent preset
```

## 行为与限制

- 模式是**每个 Session 的持久状态**：打开后 DSH 重启 / 会话恢复仍然打开，需要人类关闭。
- 通知保留最近 64 条（projection 常量截断）；更早的记录仍在 Session 日志里。
- 冷 DevLead 会话默认只留持久通知记录，不自动 resume（`wakeColdSession: false`）。
- watch 上限默认 64；命令的候选列表默认截断在 200 行，列表外的会话会回退到 core 的
  `getSession` 解析。
- 不做 git 克隆 / worktree 管理；不跨进程编排；不替人类做权限决策。
- 兼容性：`engines.dsh: >=0.2.2-rc.1 <0.3.0`；本地构建 / 发布需要 Node.js ≥ 24.9、pnpm 12。

## 文档

- 仓库 [README](../../README.md)：功能、安装、使用、通知机制、配置与故障排查
- [DESIGN](../../docs/DESIGN.md)：领域模型、持久记录、核心服务 API、通知泵与权限模型
- [PUBLISHING](../../docs/PUBLISHING.md)：npm trusted publishing 发布流程
- [v0.1.0 release notes](../../docs/releases/v0.1.0.md)
