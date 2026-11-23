# 动态看板路径 / lead-only UI 收口轮：门禁与真实 E2E 证据

日期：2026-11-23（Asia/Shanghai）
基线：`main @ 4e25b70`（Step A/B + 复核修复已 push 的干净树）
运行 DSH：安装版 **0.2.2-rc.5**（`dsh --version`；与 `scripts/e2e-smoke.mjs` 的
`BASELINE_DSH_VERSION` 一致）。工具链：Node v26.13.0、pnpm 12.16.1。
本文件记录项目看板从「必须显式配置 `boardPath`」改为「默认跟随 active lead workspace」这一轮
的真实门禁输出与 E2E 结果，并覆盖同轮的 P2-1/P2-2 修复、80 KiB→64 KiB 读取上限、
schema-invalid 缓存测试、以及 client-ui 对 devlead 运行期依赖的移除。**没有 bump 版本、
没有改 profile、没有 tag/stage/publish。**

## 提交

| Commit | 内容 |
| --- | --- |
| `e4ff951` | `feat(protocol): share the default board location and read cap` |
| `09fa934` | `feat(devlead): follow the active lead workspace for the project board`（含 P2-1 preflight 修复、64 KiB 读取上限、P2-2 降级） |
| `4398e3d` | `feat(tool): scope board tools and summary to the active lead` |
| `fab1988` | `feat(client-ui): show the project board only for the active lead`（含 protocol 依赖收口） |
| `363a311` | `test(e2e): cover derived board paths and lead lifecycle` |
| `81140bc` | `docs: document the dynamic board and corrected package topology` |
| 本文件 | `docs(evidence): record the dynamic board path gates` |

## 核心行为

- 看板默认启用：路径 = active lead Session 的 `SessionHeader.cwd` +
  `.dsh/devlead/board.json`；`boardPath` 仅作可选绝对路径 override，且仍在启动时预创建父目录
  （`0700`）。没有 active lead 时是 disabled store（工具 `BOARD_DISABLED`、摘要空、无 global、
  无 UI）；lead 关闭/切换时释放旧 store/watcher、换到新路径，路径未变则复用 store。
- P2-2：`start()`/父目录预创建失败只记录 `boardStartError` + warning，DevLead 服务、工具、
  命令与 UI 继续加载；board 工具随后按真实文件系统故障返回 `BOARD_IO_ERROR`。
- P2-1：update preflight 用固定合成 id `devlead-validation`，长 workspace path/title 作为
  project 引用不再误报 `BOARD_LIMIT_EXCEEDED`；未知引用仍由锁内 apply 返回
  `BOARD_PROJECT_NOT_FOUND`。
- 读取上限：`devlead_board_read` 结果 ≤ 64 KiB（`DEVLEAD_BOARD_READ_MAX_BYTES`），超限按
  tasks → blockers → project 行从尾部整行裁剪并报 `truncated:true`。
- 浏览器侧：tab/guide/header 按钮只属于屏幕上的 active lead（top-level、summary 显示 mode on）；
  Host global 增加 `leadSessionId` 与 `override`；global 缺失时 client 从 Session summary 的
  `cwd` 派生默认路径（override + late enable 需刷新页面，已写入文档）。
- 包拓扑收口：`client-ui` 的 node 入口从 `@yankeguo/dsh-devlead-protocol` 取
  `DEVLEAD_BOARD_SCHEMA_VERSION`，`packages/client-ui` 不再依赖 `@yankeguo/dsh-devlead`。

## 门禁：frozen install + verify + check:packages

命令与真实输出（完整日志见同目录 `dynamic-board-path-gates.log`）：

```text
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Done in 30ms using pnpm v12.16.1

$ pnpm run verify
$ tsc -p tsconfig.json --noEmit
 Test Files  46 passed (46)
      Tests  1738 passed (1738)
$ node scripts/build.mjs
build complete (6 targets)

$ node scripts/check-packages.mjs
check-packages: OK (6 packages)
```

新增/更新的自动化覆盖（摘要）：

- `packages/protocol/tests/board.spec.ts`：默认路径段与 64 KiB 读取上限常量（48 tests）。
- `packages/devlead/tests/board.spec.ts`：P2-1 长短 path/title 引用、未知引用、读取裁剪
  （tasks/blockers/project 行）、schema-invalid 外部文件保留最后合法缓存且 update 不覆盖。
- `packages/devlead/tests/board-lifecycle.spec.ts`（新增）：路径优先级（override > lead
  workspace > disabled）、规范化、无 lead/无 workspace、lead 启用/关闭/切换的 store 切换、
  冷 lead 从持久 header 恢复、预创建 0700、P2-2 不可创建父目录仍能加载。
- `packages/tool/tests/board-tools.spec.ts`：read 走 lead-scoped `readBoard`、长引用透传、
  `BOARD_PROJECT_NOT_FOUND` 错误映射、摘要仅对 owning lead 注入。
- `packages/client-ui/tests/*`（309 tests）：global 解析优先级/派生、非 lead 零注册、lead 注册、
  mode-off/切换 dispose、路径变化重读、空态/错误态保持。

## E2E：rc.5 三条 flow 全绿

| Flow | 结果 | 分阶段 |
| --- | --- | --- |
| patch 完整 | **238/238**（235 PASS + 3 credential-less SKIP） | 30 / 18 / 24 / 135 / 31 |
| installed 完整 | **238/238**（同上） | 同上 |
| patch `--no-worktree` | **214/214** | 30 / 18 / — / 135 / 31 |

完整日志：`dynamic-board-path-e2e-patch.log`、`dynamic-board-path-e2e-installed.log`、
`dynamic-board-path-e2e-no-worktree.log`。尾部汇总行：

```text
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1 (default profile): 30/30 checks
  phase 1b (cold lead rehydration): 18/18 checks
  phase 2 (experimental worktree composition): 24/24 checks
  phase 3 (close tools, dispatch routing, and triage policy): 135/135 checks
  phase 1e (message lanes, merge, action cap, metrics): 31/31 checks
  total: 238/238 checks (PASS + SKIP; see per-phase lines)

E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
  total: 238/238 checks (PASS + SKIP; see per-phase lines)

E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  total: 214/214 checks (PASS + SKIP; see per-phase lines); phase 2 skipped (--no-worktree)
```

本轮 board 相关的真实断言（摘自 patch 日志，installed 流同样通过）：

```text
PASS default board global follows the lead workspace without configuration ::
  {"boardPath":"…/workspace/.dsh/devlead/board.json","schemaVersion":1,"pathPlatform":"posix",
   "leadSessionId":"session-702e…","override":false}
PASS enabling the lead precreates the derived board parent directory :: …/workspace/.dsh/devlead
PASS restarted Host derives the cold lead board path from its persisted header ::
  {"boardPath":"…/workspace/.dsh/devlead/board.json",…,"leadSessionId":"session-702e…","override":false}
PASS disabling the lead removes the board global
PASS switching the lead workspace switches the derived board path ::
  {"boardPath":"…/workspace-b/.dsh/devlead/board.json",…,"leadSessionId":"session-18fc…","override":false}
PASS configured boardPath override wins over the lead workspace derivation ::
  {"boardPath":"…/board/board.json",…,"override":true}
PASS phase 3 real board create + CAS + path/title refs + Host read-back succeed
  (revisions 1→2→3→4; the 3/4 writes select the project by workspace path / workspace title)
PASS phase 3 board reports the derived workspace path and the lead identity
PASS phase 3 webserver/index-inject publishes the derived board global
PASS phase 3 board disk bytes carry revision 4, the CAS focus, the ref updates, and the task
PASS phase 3 disabling the mode releases the board store ::
  {"enabled":false,"boardPath":null,"boardLeadSessionId":null,"override":false,
   "error":{"code":"DEVLEAD_NOT_ENABLED",…}}
PASS phase 3 disabling the mode removes the board global
```

## 边界与未覆盖项

- 「没有 workspace 根的 lead → `BOARD_DISABLED`」由 Host 单测（`board-lifecycle.spec.ts`）覆盖；
  E2E 的 HTTP `session/create` 总会给 Session 落一个 cwd（进程 cwd），因此无法在真实 Web Host
  上构造该场景，未写成 E2E 断言。
- 浏览器视觉/主题/交互仍按 [UI-VERIFICATION](../UI-VERIFICATION.md) 在隔离 profile 人工验收；
  本轮 E2E 只证明 Host 行为、global 注入、boot graph 与磁盘 read-back，不替代截图/视觉检查。
- 既有 `boardPath` 部署升级后继续生效（override 优先）；但页面在 lead 启用之前加载时，override
  路径要等页面刷新后才会出现在 global 中（默认路径无需刷新）——已写入 BOARD/README/COMPATIBILITY。
- `boardPath` 最终组件不能是 symlink 的既有约束不变；目录链中的 symlink 可正常工作。
