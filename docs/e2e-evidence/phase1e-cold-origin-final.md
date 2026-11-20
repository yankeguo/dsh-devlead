# Phase 1e cold-origin 收口轮（replay closure）— 证据

- 基线：`main` @ `04dd7cc`；本轮修复 delta 复审残留的 A1/A2 与 nit，是 cold-origin 的收口轮。
- 单父普通 commit：`fix(devlead): close cold-origin replay gaps for background receipts`。
- 先冻结 source → build → 三条 e2e；e2e 之后只改 docs/evidence（时间线见下）。

## A1：无 origin 的 `persistReport` 仍会 inject cold-observed background

旧路径：cold queue 里的 background report（digest-only）在 Agent 变 live 后，调用无 origin 的
`persistReport` 时 `coldObserved` 只看 origin/Agent liveness → false → append 后 `routeReport`
→ inject。

修复：新增 hub 侧 `coldQueuedReports` marker（[notification.ts:141](../../packages/devlead/src/notification.ts#L141)）：

- `queueUnsavedReport(live=false)` 时对 background 记入 marker（:717-723），仅作 origin 标记，
  不 arm timer。
- `persistReport` 的 `coldObserved` 在无 origin 时检查该 marker（:601-606），cold-origin
  background 只 append receipt + digest-only，不 route。
- marker 在 `settleColdBackground`/`dropUnsavedReport`/durable dedupe/degrade/setWatched 时清除；
  action-required 不记 marker，cold wake 语义不变。
- `origin:'live'` 显式覆盖 marker，但仍受 Agent liveness 限制：attach-only cold 时只补 receipt +
  digest-only（不在 README/DESIGN 承诺 late inject）。

## A2：service outbox replay 的 cold receipt append 失败无 retry

旧路径：启动 replay 调 `persistReport(report,'cold')`，append 失败走 `queueUnsavedReport(false)`，
不调用 `queueColdReportFailure`；`replayOutbox` 失败分支只 log。

修复：

- `persistReport` 的 cold append catch 调用 `queueColdReportFailure`
  （[notification.ts:622-634](../../packages/devlead/src/notification.ts#L622)），复用 1s × 8
  `flushBackground`，只补 receipt + digest-only，不 inject。
- `replayOutbox` 的失败分支 arm 有界 `scheduleOutboxReplayRetry(false)`
  （[index.ts:2595-2602](../../packages/devlead/src/index.ts#L2595)），最终清 outbox row；
  hub retry 与 delayed replay 通过 durable `known`/`dropUnsavedReport` 去重。

## Nits

1. `backgroundRetryAttempts`：新 live/cold failure 入队时 reset（同一 burst 内新失败也有完整
   8 次）；成功/无 work/drop/agent-undefined 仍 reset。测试“same-burst new failure full budget”。
2. `origin:'live'` + attach-only cold：行为固定为 durable receipt + digest-only（无 Agent 可
   inject），README/DESIGN 明确；补测试。
3. `outbox.put(report)`：`origin` 省略时保留 `existing.origin`（[outbox.ts:272-286](../../packages/devlead/src/outbox.ts#L272)），
   补 same-key retry 测试。
4. legacy 无 origin 按 cold、rollback 会 backup-and-skip 的说明保留在 DESIGN/证据，README
   补“旧 live background row 可能只进 digest、回滚窗口需人工处理”。

## 新增测试与 negative control

新增 6 条（1345 → **1351**）：

- notification.spec：attach-only cold + append failure + 无 origin `persistReport` → inject=0、
  digest-only、receipt durable；cold-observed receipt 在 hub-direct persist 失败一次 → bounded
  retry 持久化、inject=0；attach-only cold + live-origin → digest-only；same-burst 新失败完整
  重试。
- outbox.spec：same-key retry 省略 origin 时保留已记录 origin。
- service.spec：重启后 cold outbox replay append 失败一次 → hub cold retry + delayed replay
  最终持久化 receipt、`injects=0`、outbox row 清空。

**Negative control**：仅回退 `packages/devlead/src`（保留新测试），实测 **5 条**失败：

```
FAIL notification.spec.ts > keeps an attach-only cold background report digest-only when persistReport runs without origin
FAIL notification.spec.ts > retries a cold-observed receipt after a failed hub-direct persistReport
FAIL notification.spec.ts > gives a same-burst new failure the full retry budget
FAIL outbox.spec.ts > keeps the recorded origin when a same-key retry omits it
FAIL service.spec.ts > retries a cold outbox replay receipt failure and clears the row without injecting
```

关键失败：attach-only 旧代码直接 `injects` 长度 1；service replay 旧代码 1.3s 后 outbox row 仍
在（无 cold retry）；same-key 旧代码 origin 被覆盖为 undefined。

## 门禁（最终冻结树）

| 门禁 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm verify` | typecheck 通过；**30 文件 / 1351 tests passed**；build **6 targets** | 0 |
| `pnpm check:packages` | `OK (6 packages)` | 0 |
| `pnpm e2e`（patch） | **221/221**（27+12+23+128+31；218 PASS + 3 SKIP） | 0 |
| `pnpm e2e --flow installed --no-build` | **221/221** | 0 |
| `pnpm e2e --no-worktree --no-build` | **198/198**（phase 2 skipped） | 0 |

- patch：[phase1e-cold-origin-final-patch.log](phase1e-cold-origin-final-patch.log)（`PATCH_EXIT=0`）
- installed：[phase1e-cold-origin-final-installed.log](phase1e-cold-origin-final-installed.log)（`INSTALLED_EXIT=0`）
- no-worktree：[phase1e-cold-origin-final-no-worktree.log](phase1e-cold-origin-final-no-worktree.log)（`NOWORKTREE_EXIT=0`）

## 时间线（source 冻结 → build → e2e → commit）

| 事件 | 时间（Asia/Shanghai） | 证据 |
| --- | --- | --- |
| 最后 source 写入（src：notification/index/outbox） | 2026-11-20T11:53:06 | `stat -f %Sm` |
| 最后 source 写入（tests） | 2026-11-20T11:52:36（notification.spec 11:52:25） | `stat -f %Sm` |
| `pnpm verify` 开始/结束 | 11:53:16 / 11:53:31 | `/tmp/final-verify.log`（`VERIFY_EXIT=0`） |
| build 产物 `packages/*/lib` | 11:53:35 | `stat -f %Sm packages/*/lib/index.js`（verify build 11:53:31；`pnpm e2e` patch 在 11:53:35 重建同内容） |
| patch e2e | 11:53:35 → 11:54:01 | [patch log](phase1e-cold-origin-final-patch.log) mtime 11:54:01 |
| installed e2e | 11:54:03 → 11:54:29 | [installed log](phase1e-cold-origin-final-installed.log) mtime 11:54:29 |
| no-worktree e2e | 11:54:32 → 11:54:57 | [no-worktree log](phase1e-cold-origin-final-no-worktree.log) mtime 11:54:57 |
| 本 commit | 2026-11-20T11:56:00+0800 | `git show -s --format=%cI HEAD` |

自洽性：**source mtime ≤ 11:53:06 < lib 11:53:35 < 首条 e2e 日志 11:54:01 < 最后一条 11:54:57 <
commit 时间**。e2e 期间及之后只编辑 docs/evidence，未再写 `packages/**`。

## 残余风险

- 旧 outbox row 无 origin 时 background 按 cold（不做 late inject）；旧 live background row 可能
  只进 digest。回滚到 pre-origin 构建会 backup-and-skip 带 origin 的新 row（新构建仍可 replay）。
- cold background receipt retry cap 1s × 8；超过后 warning + 保留 row，下一次 live index 再试。
- e2e 不构造真实 append 失败；该路径由 vitest（fake timers）覆盖。发布前仍需按
  `docs/PUBLISHING.md` 重跑完整组合。
