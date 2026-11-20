# Phase 1e 复核修复轮（background report receipt retry）— 证据

- 基线：合并树 `main` @ `2736d72`（Phase 1e × cold-discard r3–r9）。
- 本轮修复 1e 首次独立审的 **major**：live lead 的 background report append 失败后无
  retry/inject，报告被静默搁置；并收口 reviewer 列出的四个 nit。
- 修复 commit：本提交（`fix(devlead): retry failed background report receipts and keep live lane delivery`），
  仅本地，未 push / 未改 version / 未打 tag / 未 publish。

## 失败路径与修复

旧行为（合并树）：

1. `report()`/`persistReport()` 的 `appendReportRecord` 失败 → `queueUnsavedReport`。
2. background 分支只 `unsavedReports.push` + `deliveryState='digest-only'` + `countReport('digest-only')`，
   没有 `scheduleFlush`/`scheduleActionFlush`/retry timer。
3. `hasOrdinaryWork` 只数 T1 `unsaved`，`hasActionWork` 只数 action；background row 永不触发 flush。
4. `persistUnsaved` 只在 syncLead/archived/flush 时调用；lead 已 live 且无后续事件时该 row
   永久停留。
5. 无 outbox：`durable:false, queued:true` 后 row 只在内存 → 无 inject、无 durable receipt、无 retry。
6. 有 outbox：`persistReport` 返回 false，outbox 行保留；`replayOutbox` 只在 boot/mount/
   agent 创建/mode/watch 变化时触发，无 retry timer。
7. 即使后续 persist，background 分支无条件 digest-only，把 live append failure 误当 cold 观察。

修复（合并树坐标）：

- `LeadRuntime` 新增 `liveReportFailures`（[notification.ts:133](../../packages/devlead/src/notification.ts#L133)）、
  `backgroundTimer`/`backgroundRetryAttempts`（:146-149），区分 live append failure 与
  cold-observed。
- `queueUnsavedReport(runtime, report, live)`（[notification.ts:681](../../packages/devlead/src/notification.ts#L681)）：
  live 失败 → `deliveryState='pending'`、metric `queued`、arm background retry；cold 观察 →
  仍 `digest-only`，且 metric 只在此处计一次。
- 独立有界 retry：`scheduleBackgroundRetry`（[notification.ts:1922](../../packages/devlead/src/notification.ts#L1922)）→
  `flushBackground`（[notification.ts:1939](../../packages/devlead/src/notification.ts#L1939)）。
  1s × `MAX_BACKGROUND_REPORT_RETRIES`(8)；成功 append 后
  `persistUnsaved` → `deliverBackground`（[notification.ts:1493](../../packages/devlead/src/notification.ts#L1493)）
  恰好一次 inject；超过上限 `degradeLiveBackground`（[notification.ts:1968](../../packages/devlead/src/notification.ts#L1968)）
  降级 digest-only + 显式 warning，不无限重试。
- 去重：`persistReport` 成功 append / 发现 receipt 已 durable 时
  `dropUnsavedReport`（[notification.ts:719](../../packages/devlead/src/notification.ts#L719)）；
  `persistUnsaved` 先查 durable `state.reports`，避免 hub retry 与 outbox replay 双投递。
- service 有界 outbox replay：`scheduleOutboxReplayRetry`（[index.ts:2607](../../packages/devlead/src/index.ts#L2607)），
  1s × 5，仅当 outbox 中存在 live lead 的 report 行；`deliverReport` 在 `persistReport`
  返回 false（append 失败）后 arm；dispose 清理 timer（[index.ts:946](../../packages/devlead/src/index.ts#L946)）。
- cold-observed background 仍 digest-only（`persistUnsaved` 不再二次计数）；
  `repairLifecycle` 补 `countRepair`（[answers.ts:127](../../packages/devlead/src/answers.ts#L127)）；
  `renderDevLeadReviewNotice` 复用 `boundWake`（[notification.ts:279](../../packages/devlead/src/notification.ts#L279)）；
  `DevLeadProjectionReport` 明确不投影 `repairPending`，以 tool 输出为准（DESIGN §4.4 已记录
  Phase 2 缺口）。

## 测试与 negative control

新增测试（9 条）：

- [notification.spec.ts](../../packages/devlead/tests/notification.spec.ts)：live background append
  失败一次 → bounded retry → durable receipt + 恰好一次 background inject（无 outbox 变体）；
  retry cap 降级；cold-observed 仍 digest-only 且 metric 只计一次；dispose 清 timer；
  `deliverNow` 立即 drain 且随后不重复 inject；review wake 8k bound。
- [service.spec.ts](../../packages/devlead/tests/service.spec.ts)：有 outbox 变体（append 失败 →
  outbox 保留 → 延迟 replay + inject 恰好一次）；dispose 清 outbox replay timer。
- [answers.spec.ts](../../packages/devlead/tests/answers.spec.ts)：repairLifecycle answer/question
  counters。

**Negative control**：仅回退 source 修复（保留新测试），实测 **8 条**相关测试失败。第 9 条
（hub dispose 清 timer）在旧代码上会因“根本没有 timer”而平凡通过，它是新增定时器的回归守卫，
不算旧 bug 的失败捕获：

```
FAIL answers.spec.ts > counts answer/question status when repairLifecycle changes the state
FAIL notification.spec.ts > bounds the review wake and keeps its truncation guidance
FAIL notification.spec.ts > retries a live background report receipt append failure and injects exactly once
FAIL notification.spec.ts > drains a live background receipt retry immediately through deliverNow
FAIL notification.spec.ts > bounds background receipt retries and degrades to digest-only after the cap
FAIL notification.spec.ts > keeps a cold-observed background report digest-only and counts it once
FAIL service.spec.ts > retries a live background report receipt append failure from the outbox and injects once
FAIL service.spec.ts > clears the delayed outbox replay timer on dispose
```

其中旧 bug 的直接断言：live 失败后 `deliveryState` 实际为 `digest-only`，期望 `pending`
（`expected 'digest-only' to be 'pending'`）。

## 门禁（修复树实跑）

| 门禁 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm verify` | typecheck 通过；**30 文件 / 1339 tests passed**；build **6 targets** | 0 |
| `pnpm check:packages` | `OK (6 packages)` | 0 |
| `pnpm e2e`（patch） | **221/221**（218 PASS + 3 SKIP；27 + 12 + 23 + 128 + 31） | 0 |
| `pnpm e2e --flow installed --no-build` | **221/221** | 0 |
| `pnpm e2e --no-worktree --no-build` | **198/198**（phase 2 skipped） | 0 |

- patch：[phase1e-bg-retry-patch.log](phase1e-bg-retry-patch.log)（`PATCH_EXIT=0`）
- installed：[phase1e-bg-retry-installed.log](phase1e-bg-retry-installed.log)（`INSTALLED_EXIT=0`）
- no-worktree：[phase1e-bg-retry-no-worktree.log](phase1e-bg-retry-no-worktree.log)（`NOWORKTREE_EXIT=0`）

## 残余风险 / 未覆盖

- Retry cap 为 1s × 8：持续超过 8s 的 append 故障会降级 digest-only（有 warning），
  不再保证 inject；后续 live index/persist 仍可补写 durable receipt，但 lane 不再重放。
- outbox delayed replay 同样有 1s × 5 cap；超过后行仍 durable，等下一次 activation/restart。
- cold-observed background 仍按既有策略 digest-only，本轮未改变 cold wake 语义。
- e2e 不构造真实 append 失败，该路径由 vitest（含 fake timers）覆盖；发布前仍需按
  `docs/PUBLISHING.md` 重跑完整组合。
