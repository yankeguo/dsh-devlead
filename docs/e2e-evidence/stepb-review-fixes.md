# Step B 复核修复轮：P2/P3 修复、schema 收敛与真实门禁证据

日期：2026-11-23（Asia/Shanghai）
基线：`main @ fb2a835`（Step A 复核修复后、Step B 只读面板已合入的干净树）
运行 DSH：安装版 **0.2.2-rc.5**（`dsh --version`，与 `scripts/e2e-smoke.mjs` 的
`BASELINE_DSH_VERSION` 一致）。工具链：Node 26.13.0、pnpm 12.16.1。
本文件记录 Step B 独立复核 verdict = **concerns（无 P1）** 之后的一轮修复：所有 P2 必改项、
P3 低风险项、文档与 e2e 断言修正，以及这些改动在冻结树上的真实门禁输出。**没有 bump 版本、
没有改 profile、没有 tag、没有 stage/publish**。

## 提交

| Commit | 内容 |
| --- | --- |
| `47f636a` | `refactor(protocol): centralize the board wire schema`（P2-3/P2-5） |
| `7910620` | `fix(client-ui): cover the board empty state with bounded polling`（P2-1/P2-4/P3-4 abort） |
| `02a44b1` | `fix(client-ui): scope board ids and harden panel states`（P3-1/P3-2/P3-4） |
| `1727d3b` | `test(e2e): cover the disabled board global and correct Step B docs`（P2-2/P3-3/P3-5） |
| `b9988e7` | `docs: align board architecture, runbooks, and package docs`（复核 F1/F2/F3/F4 文档收口） |

本文件与下列日志位于同一证据 commit；门禁在 `b9988e7` 上执行，代码/测试内容与 E2E 运行的
`1727d3b` 相同（两 commit 之间只有 README 与 `docs/` 的差异）：

```text
$ git diff --stat 1727d3b..b9988e7
 README.md                     |  3 ++-
 docs/BOARD.md                 |  6 ++++--
 docs/CONTRIBUTING.md          | 14 +++++++-------
 docs/DESIGN.md                | 29 ++++++++++++++++++-----------
 docs/OPTIONAL-DEPENDENCIES.md |  8 ++++++--
 docs/PUBLISHING.md            | 12 ++++++------
 packages/protocol/README.md   | 22 +++++++++++++++-------
```

## 逐项修复

| 复核项 | 修复 | 结果 |
| --- | --- | --- |
| P2-1 首次使用静默不刷新 | `useBoardFile` 在 `status === 'empty'` 时做有界轮询：默认 4s 起、指数退避到 30s 上限；effect 只依赖 `state.status`，`refreshing` 切换不重置退避；读到数据/切状态/卸载即停，复用既有 abort/generation。watch 断开仍显示「自动更新已断开，请手动刷新」且不静默自动重连。README/BOARD/UI-VERIFICATION 措辞同步限定为「watch 为主 + 空态轮询兜底」。 | README/BOARD 与实现一致；`useBoardFile.spec.tsx` 19 tests 覆盖轮询 tick 数、退避、停止、卸载、watch 降级 |
| P2-2 static inject 文档 | 更正 COMPATIBILITY/BOARD：`dsh.client.inject` 是静态包声明，不随 boardPath 增删；未配置时 `apply()` 零看板注册、Host 不注入 global。`apply.spec.ts` 增加回归锚点（精确 static inject 列表 + 恰好 4 个既有 surface 注册 + 2 个 effect）。 | e2e phase 1 负向断言实测通过 |
| P2-3/P2-5 schema 单一事实源 | 见下节「Schema 收敛方案」。新增 `packages/protocol/tests/board.spec.ts`（47 tests）与 client `board.spec.ts` 拒绝矩阵（46 tests）。 | 跨包 accept/reject 矩阵落地，duplicate workspace path 漂移已消除 |
| P2-4 watch 降级测试 | `changes()` 同步 throw、stream 迭代中途 reject 两条路径：`watch:'ended'`、已加载 board 保持 ready 且不变 parse/read error、手动刷新重连；并断言无静默自动重连。 | `useBoardFile.spec.tsx` 覆盖 |
| P3-1 DOM id 冲突 | 组标题 id 以 React `useId()` 前缀生成，`aria-labelledby` 同步；渲染测试同时挂载两个面板，断言 8 个 heading id 互不重叠且各自可解析。 | `board-render.spec.tsx` |
| P3-2 unlisted error 优先 | workspace 清单 error 优先于 pending（phase 仍为 pending 时也显示错误而非「读取中」）；看板文件未就绪仍只显示「不可用」。 | `board-render.spec.tsx` |
| P3-3 文档 | README（中/英）/BOARD 修正偏强措辞，明确自动化覆盖边界与人工视觉验收；`boardPath` 增加「最终组件不能是 symlink、目录链可为 symlink」caveat；PUBLISHING/CONTRIBUTING/OPTIONAL-DEPENDENCIES/DESIGN 同步新 pin 与架构事实。 | 复核 F1/F2 已修复 |
| P3-4 回归钉 | XSS（含 `<img onerror>`/`<script>` 文本渲染为文本、无事件属性/DOM 注入）、a11y（refresh `aria-label`/`aria-busy`、`role=status`+`aria-live`、错误 `role=alert`、group heading 关联、原生 details/summary、只读控件扫描）、卸载时 in-flight `stat`/`readBytes` abort（signal.aborted、迟到结果被忽略、无 act 警告）。 | `board-render.spec.tsx` + `useBoardFile.spec.tsx` |
| P3-5 e2e 负向断言 | phase 1/1b 改回未配置 boardPath 的默认组合，新增断言：index HTML 不含 `__DSH_DEVLEAD_BOARD__`，同时 static inject 仍声明看板客户端服务；phase 2/3/1e 才应用 scratch board overlay。`EXPECTED_CHECKS` pin 改为 phase 1=28，完整流 226、no-worktree 203。 | patch/installed 226/226、no-worktree 203/203 实测通过 |

## Schema 收敛方案

- **唯一实现**：`packages/protocol/src/board.ts` 提供 `createDevLeadBoardSchema(isAbsolutePath)`
  与全部 wire 常量（schemaVersion、256 KiB、50 projects / 200 tasks / 50 blockers、4000 text /
  128 id / 200 title / 4096 path / 64 timestamp）、持久类型和 RFC 6901 issue 映射。strict 对象、
  重复 project id / 重复 workspace path / 重复 blocker/task id、UTC-only 时间、未知字段拒绝
  全部只有这一份代码。
- **Host**：`devlead/src/board.ts` 以 `node:path.isAbsolute` 构造 schema，删除本地 schema/常量/
  interface 定义并 re-export 共享名字；`too_big => BOARD_LIMIT_EXCEEDED` 映射与 issue 顺序保持
  Step A 语义（复核用临时差分脚本对新旧 schema 跑 3,054 例结构化 + fuzz 输入，success 值与
  issue code/path/message/顺序完全一致）。
- **浏览器**：`client-ui/src/client/board.ts` 按 Host 发布的 `pathPlatform` 缓存
  posix/win32 两个 decoder，只保留浏览器侧职责（global 配置校验、UTF-8/大小预检、分组/排序/
  unlisted 纯函数）。Step A 后才加入 Host 的 duplicate-workspace-path 规则因此自动生效。
- **构建/依赖**：`@yankeguo/*` 在 host 构建中 external、在浏览器构建中按纯 wire layer 内联，
  因此 protocol 可被 host 与浏览器共用；`zod` 是 DSH frozen module table 的 platform
  singleton（`scripts/client-externals.mjs`；Step B 之前 client `board.ts` 已直接依赖它，本轮
  没有新增浏览器运行期依赖）。两个 protocol 发布入口（host 构建）各自打包 zod，安装 profile
  不需要额外解析；`zod` peer range `^4.4.3` 仅声明 schema 源码的依赖线，与 devlead 既有声明
  一致，不是对可选插件的硬依赖。
- **契约测试**：`packages/protocol/tests/board.spec.ts` 固化 accept/reject 矩阵（duplicate
  workspace path、重复 project/task/blocker id、未知嵌套字段、错误枚举、超限、坏时间、非绝对
  路径 posix/win32、schemaVersion、常量 pin、issue pointer）；client `board.spec.ts` 补齐浏览器
  消费面矩阵，Host 既有 `board.spec.ts` 保持全绿。

## 门禁结果（`b9988e7` 冻结树）

完整日志：`stepb-review-gates.log`（install/verify/check-packages 与真实 exit code）。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | `INSTALL_EXIT=0`（lockfile 已包含 protocol 的 zod peer importer） |
| `pnpm run verify` | `VERIFY_EXIT=0`；**45 个测试文件 / 1678 tests passed**；6 个构建目标成功 |
| `pnpm run check:packages` | `CHECK_PACKAGES_EXIT=0`；`check-packages: OK (6 packages)` |
| `pnpm exec tsc -p tsconfig.json --noEmit` | exit 0（含在 verify 内） |

## 真实 E2E（安装版 DSH 0.2.2-rc.5）

`DSH_BIN=<installed 0.2.2-rc.5>`，`--no-build`，独立 scratch `DSH_HOME`，未触碰桌面 profile。
原始日志：`stepb-review-e2e-patch.log` / `stepb-review-e2e-installed.log` /
`stepb-review-e2e-no-worktree.log`（均保留真实 `*_EXIT=` 与总计行）。

| 流 | 结果 |
| --- | --- |
| patch 完整流 | **226/226**（phase 1 28 + 1b 12 + 2 23 + 3 132 + 1e 31；`PATCH_EXIT=0`） |
| installed 完整流 | **226/226**（同上；`INSTALLED_EXIT=0`） |
| installed `--no-worktree` | **203/203**（phase 2 skipped；`NO_WORKTREE_EXIT=0`） |

新增负向检查的真实输出（phase 1，未配置 boardPath）：

```text
PASS disabled board publishes no global while its client injects stay declared :: 8 globals; board injects declared: true
28 PASS + 0 SKIP = 28 checks (expected 28)
```

完整流中的 3 条 SKIP 仍是「无 provider 凭据」的正向模型选择检查，不计为通过。

## Mutation 证据

`stepb-board-mutation.log` 记录三次对冻结语义的临时变异、对应用例失败、以及文件已还原
（日志末尾含 `git status`/`git diff --stat` 证明还原后除本轮文档外无残留改动）：

| 临时变异 | 被抓到的测试 |
| --- | --- |
| 删除共享 schema 的 duplicate workspace-path 规则 | `protocol/tests/board.spec.ts`、`client-ui/tests/board.spec.ts`、`devlead/tests/board.spec.ts` 各 1 条失败（3 failed / 120 passed） |
| `DEVLEAD_BOARD_MAX_PROJECTS` 50 → 51 | `protocol/tests/board.spec.ts` 常量 pin 用例失败（1 failed / 46 passed） |
| 关闭空态轮询 effect | `useBoardFile.spec.tsx` 的「有界退避」「watch ended 后仍轮询」2 条失败（2 failed / 17 passed） |

## 独立复核

修复轮完成后由独立 reviewer 复核 `fb2a835..1727d3b`：verdict = **concerns（无 P1、代码可 approve）**，
所有 P2/P3 行为项 PASS；发现的 4 项均为文档一致性（PUBLISHING/CONTRIBUTING 旧 pin、DESIGN 架构
描述、浏览器 zod 内联措辞、英文 README 漏写 unlisted error 优先），已在 `b9988e7` 全部修复。
复核记录的证据：`tsc`/定向 vitest/全量 vitest/`check-packages` 全绿；旧 Host schema 与新工厂
3,054 例差分 0 mismatch；e2e 由本轮根会话真实执行（见上表）。

## 未包含 / 边界

- 只跑 rc.5 的真实 E2E（本轮验收要求）；rc.1–rc.4 的逐 rc recipe 未重跑。
- 浏览器视觉（主题、布局、真实交互）仍需按 [UI-VERIFICATION](../UI-VERIFICATION.md) 在隔离
  profile 人工验收；本轮只提供自动化渲染/状态机断言，不以无截图状态视为视觉已通过。
- 空态轮询只覆盖「文件尚不存在」；已加载内容的 watch 断开时保持显式手动刷新状态，不静默
  切换为轮询（行为与文档一致）。
- 复查遗留风险已记录：host 产物内嵌 zod 与浏览器 module-table zod 为两个实例（当前同为
  4.4.x 语义；未来 DSH zod 升级需重跑 schema 差分）；多违规 board 的浏览器单行 parse 文案
  可能指向与旧实现不同的 JSON pointer（仅展示层；Host 接受/拒绝语义经差分证明不变）。
