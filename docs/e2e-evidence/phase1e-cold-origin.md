# Phase 1e delta 复核修复轮（cold origin）— 证据

- 基线：`main` @ `9c9e6a4`（background-retry fix）；本轮修复 delta 复审的 A1/A2 与 nit。
- 本提交为单父普通 commit（`fix(devlead): keep cold-observed background reports digest-only across replay`）。
- 只改 source 后先冻结，再 build + 三条 e2e；source 在 e2e 之后未再修改（见下方时间线）。

## A1：cold-observed background 经 outbox/replay 被 inject

旧路径：cold lead 的 background report 入 `queueUnsavedReport(live=false)` → digest-only；outbox
行保留；`replayOutbox` 调 `hub.persistReport(report)` 不携带 origin，此时 Agent 已 live、`known=false`
→ append 后无条件 `routeReport` → `deliverBackground` inject。`report()`/`persistReport()` 又用
“Session 是否 attached”判断 live，attach-only cold lead 的 append failure 会被当成 live。

修复：

- outbox row 增加可选 `origin:'live'|'cold'`（[outbox.ts:68](../../packages/devlead/src/outbox.ts#L68)、
  schema :177），admission 时按 **Agent 是否存在** 写入
  （[index.ts:2653](../../packages/devlead/src/index.ts#L2653)），replay 时读回
  `entry.origin ?? 'cold'`（[index.ts:2579](../../packages/devlead/src/index.ts#L2579)）并传给
  `hub.persistReport(report, origin)`（:2581/:2660）。
- `persistReport` 的 `coldObserved` 由 origin 或 Agent liveness 得出
  （[notification.ts:603](../../packages/devlead/src/notification.ts#L603)）；cold-origin
  background 成功 append 后只 `settleColdBackground`（digest-only，必要时计一次），**不
  route**（:631/:642）；action-required 不受影响，仍按 cold wake 策略 route。
- `report()` 的 live 判定改为 `isLeadAgentLive`（[notification.ts:567](../../packages/devlead/src/notification.ts#L567)、
  :794），attach-only cold lead 不再进入 live lane。
- 缺省 origin 的旧 background row 按 `cold` 处理：旧数据 replay 不做 late inject。

## A2：cold-observed background 的 receipt append 失败无 retry

旧路径：`persistUnsaved` 对 background append 失败只 `remainingReports.push`；cold row 没有
live marker → 不 arm timer。

修复：新增 `coldReportFailures`（[notification.ts:744](../../packages/devlead/src/notification.ts#L744)）：
`persistUnsaved` append 失败时将 cold background row 纳入同一个 1s × 8 有界 retry
（[notification.ts:2030](../../packages/devlead/src/notification.ts#L2030)）；重试成功只补 durable
receipt + digest-only（`settleColdBackground`，:787），**绝不 inject**；cap 后
`degradeBackgroundReports`（:2066）对 cold row 只告警并保留 row 等下一次 live index（live row
仍按原策略降级 digest-only + failed）。无 outbox 时同一 hub timer 生效，失败的 cold receipt 有
warning 可观察。

## Nit

- `backgroundRetryAttempts` 在成功/无 background work/drop/agent-undefined 时 reset；新 burst
  从完整 8 次开始（测试“成功后新失败仍有完整 8 次”）。
- background retry timer 补 `unref?.()`（[notification.ts:2028](../../packages/devlead/src/notification.ts#L2028)）。
- 时间线证据：见下方表格（source 冻结 → build → 三条 e2e → commit）。

## 新增测试与 negative control

新增 6 条（1339 → **1345**）：

- notification.spec：attach-only cold + append failure 保持 digest-only、激活后 inject=0；
  cold receipt append 失败一次 → bounded retry 持久化 receipt、inject=0；cold retry cap
  warning 且 timer 清理；成功 burst 后新 live failure 仍有完整 8 次。
- outbox.spec：`origin` 持久化、legacy 无 origin row 仍可解析。
- service.spec：cold-observed background + durable outbox **跨重启 replay** → outbox 行带
  `origin:'cold'`，replay 后 `injects=0`、`digest-only`、durable receipt 存在、outbox 清空。

**Negative control**：仅回退 `packages/devlead/src`（保留新测试），实测 **5 条**新测试失败：

```
FAIL notification.spec.ts > keeps an attach-only cold lead background receipt digest-only and never injects
FAIL notification.spec.ts > retries a cold-observed background receipt, persists it, and never injects
FAIL notification.spec.ts > warns after the cold receipt retry cap without injecting
FAIL outbox.spec.ts > persists the lead-liveness origin and accepts legacy rows without it
FAIL service.spec.ts > keeps a cold-observed background report digest-only through an outbox replay/restart
```

其中 attach-only 旧代码直接断言 `expected 'pending' to be 'digest-only'`；跨重启测试在旧代码上
outbox row 无 `origin`（`expected undefined to be 'cold'`）。

## 门禁（最终树实跑）

| 门禁 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm verify` | typecheck 通过；**30 文件 / 1345 tests passed**；build **6 targets** | 0 |
| `pnpm check:packages` | `OK (6 packages)` | 0 |
| `pnpm e2e`（patch） | **221/221**（27 + 12 + 23 + 128 + 31；218 PASS + 3 SKIP） | 0 |
| `pnpm e2e --flow installed --no-build` | **221/221** | 0 |
| `pnpm e2e --no-worktree --no-build` | **198/198**（phase 2 skipped） | 0 |

- patch：[phase1e-cold-origin-patch.log](phase1e-cold-origin-patch.log)（`PATCH_EXIT=0`）
- installed：[phase1e-cold-origin-installed.log](phase1e-cold-origin-installed.log)（`INSTALLED_EXIT=0`）
- no-worktree：[phase1e-cold-origin-no-worktree.log](phase1e-cold-origin-no-worktree.log)（`NOWORKTREE_EXIT=0`）

## 时间线（source 冻结 → build → e2e → commit）

| 事件 | 时间（Asia/Shanghai） | 证据 |
| --- | --- | --- |
| 最后 source 写入（tests，`notification.spec`） | 2026-11-20T11:40:22 | `stat -f %Sm` |
| 最后 source 写入（src，`notification.ts`/`index.ts`/`outbox.ts`） | 2026-11-20T11:40:16 | `stat -f %Sm` |
| `pnpm verify` 开始/结束 | 11:40:51 / 11:41:05 | 日志 `/tmp/cold-origin-verify.log`（`VERIFY_EXIT=0`） |
| build 产物 `packages/*/lib` | 11:41:05 | `stat -f %Sm packages/devlead/lib/index.js` 等 |
| `pnpm e2e`（patch） | 11:41:09 → 11:41:34 | [patch log](phase1e-cold-origin-patch.log) mtime 11:41:34 |
| installed e2e | 11:41:36 → 11:42:02 | [installed log](phase1e-cold-origin-installed.log) mtime 11:42:02 |
| no-worktree e2e | 11:42:03 → 11:42:28 | [no-worktree log](phase1e-cold-origin-no-worktree.log) mtime 11:42:28 |
| 本 commit | 2026-11-20T11:43:30+0800 | `git show -s --format=%cI HEAD` |

自洽性：**所有 source mtime ≤ 11:40:22 < lib mtime 11:41:05 < 首条 e2e 日志 11:41:34 < 最后一条
e2e 日志 11:42:28 < commit 时间**。e2e 期间及之后只编辑 docs/evidence，未再写 `packages/**`。

## 残余风险

- 旧 outbox row 无 origin：background 按 cold（保守，不 inject）；action 不受影响。
- 回滚到 pre-fix 构建时，其 strict `pending` schema 不认识新 `origin` 字段，会 backup-and-skip 这些
  row；新构建仍会 replay，回滚后该 row 的自动 replay 需人工/下一次升级处理。
- cold background receipt retry cap 为 1s × 8；超过后只告警并保留 row，下一次 live index 会再试。
- e2e 不构造真实 append 失败；该路径由 vitest（fake timers）覆盖。发布前仍需按
  `docs/PUBLISHING.md` 重跑完整组合。
