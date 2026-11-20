# Record API 可用性加固（A）— 验证证据

- 基线：主 checkout `main` @ `cc1e126148a43bdb7c6b0b93b9dca03319f4a5aa`。
- 范围：只做 record API facade、显式降级、隐私披露与升级门禁；不做 F spike 的派生改造。
- 首轮门禁在同一棵最终生产代码/文档树上真实运行；三条 E2E 均使用当时 `pnpm verify` 刚产出的
  构建并传 `--no-build`，日志末尾追加真实 `*_EXIT=` 行。后续复核 amend 只改测试/文档，既有 E2E
  日志对应的运行时构建未变，因此不重跑 E2E。
- 未 push、未改 version、未打 tag、未 publish。本轮未修改 DSH 只读 clone 或隔离 F worktree，
  且 A commit 不包含它们的内容。

## 实现与 negative control

- `packages/devlead/src/record-api.ts` 是生产代码唯一访问 `appendPluginRecord` / `pluginRecordOf`
  的模块。namespace import 避免缺失命名导出在 ESM 实例化阶段直接让插件加载失败；Service init
  探测两个 function，首次读/写异常进入带 reason 的 `degraded`，结构化 warning 只发一次。
- 只有失败的那次 `appendRecord` 返回 `false`、不抛出；`readRecord` 返回 `undefined`。生产写入用
  `appendRecordOrThrow` 接入原有 catch/retry/rollback 路径，不把失败写入假报为 durable。只有读路径
  健康时才允许 best-effort 写重试；reader 缺失或曾抛错后 writer 也 fail closed，避免写入 projection
  与单活扫描不可见的记录。degraded 不自动清除，因为之前丢失的写入不能由一次后续成功证明已恢复。
- degraded 时 `/devlead status` 与每个成功的 `/devlead ...` 视图都显示
  `Durable state: unavailable ... (memory-only)`（`statusLines` 是公共 body）；available 输出保持
  原样。三个 fold 保持最后有效状态（仅当 reader 从未可用时才是默认状态）、`failure:null`、不冻结；
  writer-only 缺失时健康 reader 仍读回既有 durable 状态。严格 payload 解码失败的冻结语义不变。
- `record-api.spec.ts` 的正常路径 negative control 直接核对 append/read 各调用一次、无 warning、
  fold 正常 enable；另外覆盖 writer-only 缺失（真实 Service `setEnabled` 抛错、事件数不变、enabled
  与 `questionAnswerView` 仍读回 durable 状态）、reader-only 缺失、reader 晚失败后 writer 零调用且
  fold 保留最后有效状态、持续写错、warn-once、失败 append=false，以及真实 Service degraded boot
  恰好一条 `ctx.logger.warn`。既有 notification/service 严格 retry/rollback 测试未放宽。

## M8 mutation negative control（/tmp 副本）

在 `/tmp/dsh-devlead-record-api-m8.sxrGxH` 复制当前源码并链接同一依赖，不改主 checkout：

| Mutation | 真实结果 | 证明 |
| --- | --- | --- |
| writer-missing 分支由 `return false` 改为 `return true` | **1 failed / 8 passed**，`MUTANT_WRITER_MISSING_EXIT=1` | writer-only 用例在直接 `appendRecord` 断言处捕获假报 durable 成功 |
| 恢复 writer，删除 `initializeRecordApi(this.ctx.logger)` | **1 failed / 8 passed**，`MUTANT_INIT_REMOVED_EXIT=1` | 真实 Service boot 的 `warnings` 为 0 而非恰好 1 |
| 恢复两处 | **9/9 passed**，`MUTATION_RESTORED_EXIT=0` | 测试在正确实现上恢复全绿 |

实际输出见 [review-mutation.log](phase1e-record-api-hardening-review-mutation.log)。

## 门禁（最终树实跑）

| 门禁 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm verify` | typecheck 通过；**31 文件 / 1362 tests passed**；build **6 targets** | 0 |
| `pnpm check:packages` | `OK (6 packages)` | 0 |
| `node scripts/e2e-smoke.mjs --flow patch --no-build` | **221/221**（218 PASS + 3 SKIP；phase 1 27 + 1b 12 + 2 23 + 3 128 + 1e 31） | 0 |
| `node scripts/e2e-smoke.mjs --flow installed --no-build` | **221/221**（218 PASS + 3 SKIP；同上） | 0 |
| `node scripts/e2e-smoke.mjs --no-worktree --no-build` | **198/198**（195 PASS + 3 SKIP；phase 1 27 + 1b 12 + 3 128 + 1e 31） | 0 |

复核 amend 的 `verify` / `check:packages` 完整输出与退出码见
[review-verify.log](phase1e-record-api-hardening-review-verify.log)。该 amend 为 test/docs-only；
`packages/devlead/src` 与三条既有 E2E 日志对应的运行时构建未变，故 E2E 结果继续有效。

- patch：[phase1e-record-api-hardening-patch.log](phase1e-record-api-hardening-patch.log)
  （`PATCH_EXIT=0`）
- installed：[phase1e-record-api-hardening-installed.log](phase1e-record-api-hardening-installed.log)
  （`INSTALLED_EXIT=0`）
- no-worktree：[phase1e-record-api-hardening-no-worktree.log](phase1e-record-api-hardening-no-worktree.log)
  （`NOWORKTREE_EXIT=0`）

三条 flow 均为本机真实 `dsh 0.2.2-rc.5`、独立 scratch DSH_HOME。3 条 SKIP 仍是既有无可用
provider/model 的正向模型选择检查，负向 model/preset/report 路径真实执行；没有新增 SKIP，也没有
放宽断言。

## DSH 源码核对与隐私/升级门禁

只读 `git show` 核对 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）与
`dsh-v0.2.2-rc.5`（`9c2670d3bce5275e0d1610272958121af87787bb`）：

- `packages/core/session/src/index.ts` / `types.ts`：两个 record 函数、`PluginRecordMap` 声明、
  ignorable envelope 与 best-effort migration 语义一致；`Session.snapshotEvents()` 仍存在但 deprecated。
- `packages/core/session/README.md:72`：仓外插件禁止调用；`:76`：records ignorable、format migration
  best-effort。
- `packages/session-query/session-log-export/src/archive.ts`：ZIP 写入 header + 完整 canonical JSONL。
- `packages/session/session-log-deepseek/src/index.ts` / README：`enabled` 默认 true，官方 DeepSeek
  请求路径附加 every complete canonical event；`packages/bundle/base/cordis.patch.yml:43-44`（两个
  tag 相同）默认挂载。canonical 日志还含 DSH `session/title` 事件，DevLead 记录嵌有 title 摘要。

上述事实与缓解建议已同步到 DESIGN §3、COMPATIBILITY、README/README.zh；升级门禁现要求逐 rc
验证 record 声明与语义、deprecated snapshot、schema/migration 可恢复性及最终三流 E2E，PUBLISHING
也把它列为 stage 前置条件。

## 残余风险 / 未覆盖

- API 缺失/抛错通过 facade 注入做确定性测试；三条真实 E2E 验证正常 API 路径，没有篡改本机 DSH
  安装来制造物理缺失。namespace import 的加载安全性由实现形式保证，但仍需在未来真实上游变化时
  按升级门禁复验。
- degraded 是进程级粘性健康状态，不代表 durable 状态已恢复；后续重试成功也不能找回先前丢失的
  record。本改动不提供替代 durable storage，F spike 不在本范围。
- canonical ZIP 导出与默认上传路径由 rc.1/rc.5 源码和文档核对，本轮没有生成含真实敏感数据的 ZIP、
  没有向官方模型端点发起上传，也没有改变该默认行为。
- `Session.snapshotEvents()` 的 deprecated 生产债务仍按原范围保留；record format migration 仍是
  DSH best-effort，不能据此承诺旧记录一定可恢复。
- 已知低风险 nit（F12/F13）：错误包装目前不保留 `cause`，degraded 文案也未细分 transient failure
  与当前 unavailable。为保持本轮 test/docs-only 和正常路径零变化，未改运行时代码；后续若调整需
  单独补兼容性测试。

## Timeline（复核 amend）

以下时间均以 ISO 8601 记录；source/lib/log 来自 `stat`，commit 来自 `git show -s --format=%cI HEAD`。
`lib` 虽因 verify 重新写入而更新 mtime，但 amend 前后的 SHA-256 均为
`f8c1c7282230638918066ffe42c88bb5daf2449cff31bd2c65e163292efcf631`，证明运行时构建内容未变。

| 顺序/产物 | 时间 | 说明 |
| --- | --- | --- |
| runtime source `packages/devlead/src/record-api.ts` | `2026-11-20T14:55:42+08:00` | A 运行时实现最后修改时间；本轮未改 |
| 首轮 E2E patch log | `2026-11-20T14:58:27+08:00` | 首轮运行时的 patch 证据 |
| 首轮 E2E installed log | `2026-11-20T14:58:52+08:00` | 同一运行时的 installed 证据 |
| 首轮 E2E no-worktree log | `2026-11-20T14:59:17+08:00` | 同一运行时的 no-worktree 证据 |
| mutation negative-control log | `2026-11-20T15:35:27+08:00` | writer-missing / init 删除 / 恢复三轮 |
| rebuilt `packages/devlead/lib/index.js` | `2026-11-20T15:36:35+08:00` | test/docs-only verify 重新构建；SHA-256 与 amend 前相同 |
| verify / check:packages log | `2026-11-20T15:36:35+08:00` | 1362 tests 与 6 packages OK |
| amended commit `%cI` | `2026-11-20T07:38:29Z` | 单一本地 commit；未 push |
