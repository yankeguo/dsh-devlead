# DSH 兼容性矩阵

本仓库的目标兼容面是 **DeepSeek Harness `0.2.2-rc.1` – `0.2.2-rc.5`**。6 个可发布包与根
`package.json` 的 `engines.dsh` 均为 `>=0.2.2-rc.1 <0.3.0`，所有
`@deepseek-ai/dsh-*` peer 使用同一范围；本地 devDependencies 仍固定 rc.1，用最旧 API 做
类型检查。

## 契约

- DSH loader 只按 `engines.dsh` 判定插件兼容性；peer 范围供 profile 的 pnpm 检查使用。
- `0.2.2-rc.5` 落在现有 semver 范围内，**无需改 `engines.dsh` 或 peer 范围**。
- 各 rc 的能力差异：
  - `agent_teams` 从 rc.2 起可用；rc.1 返回 `DEVLEAD_TEAM_UNAVAILABLE`，不创建 Session。
  - 可选 worktree 隔离需要 Host 组合实验性 worktree/forge 服务；rc.4 / rc.5 的完整 E2E
    覆盖 phase 2。
  - rc.4 只改 DeepSeek 流式拒答的 LLM 错误码；DevLead 不分类该错误码。
  - rc.5 只改 web search provider 选择（见下）；DevLead 不读取或调用该 API。

## rc.5 web search 变更影响

rc.5 的 `dsh-web` 在未配置 `web.searchProvider` 时按模型路由选择：DeepSeek
`deepseek-official` / `deepseek-account` 走服务端 Messages search，其他路由走
`deepseek-search-api`；`WebSearchRequest` 新增可选 `llmProvider`。这是 `dsh-web` /
`dsh-tool-web` / web-search settings 的内部行为。

本仓库审计结论：

- 仓库代码中 **没有** `webSearch` / `WebSearchRequest` / `deepseek-search-api` /
  `llmProvider` 的引用，也没有 `@deepseek-ai/dsh-web` 或 `dsh-tool-web` 的 import。
- DevLead 的 DSH import 限于 session / agent / command / tool / projection / LLM catalog /
  workspace 等既有服务；dispatch 的模型选择走 `Agent.model.select` 与 `llm.*`，不经过
  web search provider 选择。
- rc.5 上完整 E2E（下）通过，说明工具面、命令、preset roster、watch/notification、单活、
  dispatch 与 report 路径均未受影响。

## 能力矩阵

| 能力 | rc.1 | rc.2 | rc.3 | rc.4 | rc.5 |
| --- | --- | --- | --- | --- | --- |
| 插件加载、13 个主工具 + `devlead_report`、`/devlead`、Web UI | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_list_agent_presets` / 真实 roster | 支持 | 支持 | 支持 | 支持 | 支持 |
| 派发模型选择 + `reasoning_effort` | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_list_models` | 支持 | 支持 | 支持 | 支持 | 支持 |
| `devlead_prompt_session interrupt`（`workspace/session-stop` providers） | 支持 | 支持 | 支持 | 支持 | 支持 |
| watched 子会话问题路由（`tools/pre-execute` + `question` report） | 支持 | 支持 | 支持 | 支持 | 支持 |
| 可选 worktree 隔离 | 可选 bundle | 可选 bundle | 可选 bundle | 可选 bundle | 可选 bundle |
| `agent_teams: true` | 不可用\* | 支持† | 支持† | 支持† | 支持† |

\* rc.1 无 `dsh-agent-team`；DevLead 通过 duck-typed `ctx.get('agentTeams')` 探测，不静态 import。
† Host 必须组合 agent-team；默认 `dsh-base` 从 rc.2 起包含。

`devlead_prompt_session interrupt` 复用五个 tag 都存在的 `workspace/session-stop` 事件；
Agent registry 的 turn provider、jobs / subagent / schedule providers，以及 aborted phase 上
把 `followup` 重归类为 `next-turn` 的 wake 逻辑，均在 rc.1–rc.5 的独立 worktree 中核对。
该能力不新增 DSH peer 范围要求。

watched 子会话问题路由依赖五个 tag 都存在的 `tools/pre-execute` waterfall 与稳定的
`ask_user_question` 工具名；legacy / timed 两种 schema 共用该名字。该结论已在 rc.1–rc.5 的
独立 worktree 中核对，未新增 DSH peer 范围要求。

## 真实 E2E

所有命令使用 npm 临时安装的 DSH CLI（`DSH_BIN`），独立 `DSH_HOME`，不修改桌面 profile。
rc.5 的临时目录固定在磁盘缓存（不是默认 `/tmp`）：

```sh
BASE="$HOME/Library/Caches/dsh-plugin-tests/dsh-devlead/rc5"
DSH_BIN="$BASE/install/node_modules/@deepseek-ai/dsh/lib/bin.js"

TMPDIR="$BASE/tmp" "$DSH_BIN" --version
# 0.2.2-rc.5

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow installed --no-worktree --no-build --root "$BASE/tmp/e2e-no-worktree"

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow installed --no-build --root "$BASE/tmp/e2e-installed"

TMPDIR="$BASE/tmp" DSH_BIN="$DSH_BIN" node scripts/e2e-smoke.mjs \
  --flow patch --no-build --root "$BASE/tmp/e2e-patch"
```

| DSH | flow | 结果 |
| --- | --- | --- |
| `0.2.2-rc.1` | installed `--no-worktree` | **120/120**（Team 不可用分支） |
| `0.2.2-rc.2` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.3` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.4` | installed `--no-worktree` | **120/120**（Team 成功分支） |
| `0.2.2-rc.4` | installed / patch 完整 | **143/143** 各（phase 2 23/23） |
| `0.2.2-rc.5` | installed `--no-worktree` | **123/123**（phase 1 27 + 1b 12 + 3 84，含问题路由 gate） |
| `0.2.2-rc.5` | installed 完整 | **143/143**（问题路由新增 3 条 phase 3 checks 之前的完整运行；v0.2.7 的 146/146 需发布前重跑） |
| `0.2.2-rc.5` | patch 完整 | **143/143**（同上） |

rc.1–rc.4 的行是各自发布时的 harness 计数；v0.2.7 问题路由给 phase 3 新增 3 条 checks，目前只有
rc.5 `--no-worktree` 行按新 harness 重跑。发布前需按 [PUBLISHING](PUBLISHING.md) 重跑完整组合。

每条 flow 有 3 条正向模型选择检查因无 provider 凭据 SKIP（打印真实原因）；负向
`DEVLEAD_MODEL_UNAVAILABLE`、`devlead_list_models`、preset roster 与 watched-child
`devlead_report` 均真实运行。

## UI 面

- rc.5 的 `@deepseek-ai/dsh-client-ui-workspace` 仍提供
  `sidebar.session.row.leading` / `.trailing` / `.hover`，Session 行仍带
  `data-row-key="session:<id>"`，行 CSS 仍使用 `border-inline: var(--dsh-sidebar-paint-inset)
  solid transparent`。现有 active overlay ring / watched mark 的 DOM 依赖未变化。
- E2E boot graph 确认 rc.5 加载 `@yankeguo/dsh-client-ui-devlead/client.js`；lead 的
  `devLead` / `devLeadMode` / `devLeadWatch` projection 均存在，summary 携带
  `devLeadMode` 与 `devLeadWatch`，且不携带 digest。DevLeadBar 读取的 `devLead` projection
  含 enabled / sessions / notifications；组件级渲染断言由 `pnpm test` 覆盖。
- rc.5 Web UI 的视觉行为未在本轮用截图工具重跑（浏览器扩展不可用）；判定依据是
  slot/DOM 源码未变、boot graph 加载成功、projection 数据与渲染测试通过。此项不替代完整
  人工视觉验收。

## 维护注意

- 每次 DSH rc 升级先跑本页命令；如果 rc.5+ 改动 `data-row-key`、slot id 或
  `--dsh-sidebar-paint-inset`，需同步 client-ui 的 CSS 与 i18n 测试。
- 不要为了 rc.5 把 `engines.dsh` 缩窄到 `>=0.2.2-rc.5`；目标仍是 rc.1–rc.5。
- 临时目录统一放在 `~/Library/Caches/dsh-plugin-tests/dsh-devlead/<rc>`，并设置
  `TMPDIR`、`--root` 与 npm cache；测试结束删除安装/缓存，只保留日志。
