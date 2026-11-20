# Phase 1e × cold-discard（r3–r9）合并轮 — 证据

- 基线：主 checkout `main` @ `08f8207`（Phase 1e，ahead origin/main 7）+ 分支
  `dsh-a673526c-9a26` @ `f3c6a3a`（cold-discard r9，base `83b0541`）。
- 合并方式：本地 `git merge --no-ff dsh-a673526c-9a26`，只创建本地 merge commit；
  **未 push、未改 version、未打 tag、未 publish**。冷分支 worktree
  `.agents/worktrees/dsh-a673526c-9a26` 未修改、未删除。
- 门禁均在合并后的主 checkout 树上真实重跑（不复用旧日志）。

## 冲突文件与解析

| 文件 | 解析 |
| --- | --- |
| `README.md` | e2e 证据表保留 1e 的 221/221 行与冷分支 r3–r9 的 188/188、165/165 历史行；`devlead_get_session`/`devlead_prompt_session`/`devlead_notifications` 行合并双方字段：1e 的 `lane`/`deliveryState`、冷分支的 `repairPending` 与 answer durable `warning?`、same-text 重试口径 |
| `README.zh.md` | 同上（中文表与段落同步） |
| `docs/DESIGN.md` | phase 表保留 1e 行与 cold-discard r3–r9 行，新增合并轮行；`stateVersion 5`/`answerSeq`、`OUTBOX_SPEC` v2、30 天 retention、repair 链全部保留；1e 与 cold-discard 段落并存 |
| `packages/devlead/src/fold.ts` | 同时保留 1e 的 `DevLeadProjectionReport`（questionStatus/answerStatus wire 派生）与冷分支导出的 `answerSchema`（outbox 复用） |
| `packages/devlead/src/index.ts` | import 合并：1e 的 `DevLeadMetrics`/`countDelivery` + 冷分支的 `DevLeadChildAnswerObserver`/`admittedAtOf`/`DerivedAnswerDiscard`；函数体自动合并（1e metrics/reportDeliveryState 与 cold drain/repair/barrier 均保留） |
| `packages/tool/src/value.ts` | `REPORT_SCHEMA` 同时保留 1e 的 `lane`/`deliveryState` 与冷分支的 `repairPending`；`reportValue` 同时透传 delivery facts 与 answer view 的 `repairPending` |

额外的语义集成修复：`packages/tool/tests/tools.spec.ts` 中冷分支的
`devlead_notifications` 深比对预期未包含 1e 新增的 `lane`；按合并后代码意图补上
`lane: 'action-required'`（不是放宽断言，仍是完整 `toEqual`）。`index.ts` 中
`promptSession` 的 answer 重试注释按双方 README 的 same-text 语义更正。

## 门禁（合并树实跑）

| 门禁 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm verify` | typecheck 通过；**30 文件 / 1330 tests passed**；build **6 targets** | 0 |
| `pnpm check:packages` | `OK (6 packages)` | 0 |
| `pnpm e2e`（patch） | **221/221**（218 PASS + 3 SKIP；phase 1 27 + 1b 12 + 2 23 + 3 128 + 1e 31） | 0 |
| `pnpm e2e --flow installed --no-build` | **221/221**（同 pin） | 0 |
| `pnpm e2e --no-worktree --no-build` | **198/198**（跳过 phase 2；phase 1 27 + 1b 12 + 3 128 + 1e 31） | 0 |
| cold 定向 vitest（service/answers/outbox/fold/tools） | **5 文件 / 632 tests passed** | 0 |

- patch：[phase1e-merge-patch.log](phase1e-merge-patch.log)（`PATCH_EXIT=0`）
- installed：[phase1e-merge-installed.log](phase1e-merge-installed.log)（`INSTALLED_EXIT=0`）
- no-worktree：[phase1e-merge-no-worktree.log](phase1e-merge-no-worktree.log)（`NOWORKTREE_EXIT=0`）

测试数核对：`1330 = 1e 分支 1236 + 冷分支新增 94`（base `83b0541` 的 1119 只计一次；
冷分支 r9 自报 1213 = 1119 + 94，两个增量不重复）。

## invariant grep（合并树）

- `OUTBOX_SPEC` → `packages/devlead/src/outbox.ts:183`，`version: 2`（`:187`，
  `compatibleVersions: [1]`）。
- `stateVersion: 5` → `packages/devlead/src/fold.ts:675`。
- `answerSeq` → `packages/protocol/src/types.ts:309`、`fold.ts:213`、`answers.ts:48`、
  `index.ts:4194` 起。
- 30 天 retention → `DEVLEAD_ANSWER_DISCARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000`
  （`outbox.ts:59`）。
- `repairPending` → `protocol/src/types.ts:361`、`tool/src/value.ts:294`（schema）与
  `:454`（reportValue）、`index.ts:4241` 起（questionAnswerView）。
- `ANSWER_DISCARD_DRAIN_TIMEOUT_MS` → `index.ts:317`；`awaitBounded` → `index.ts:4878`；
  `awaitDiscardDrain` → `index.ts:4860`；`REPAIR_BARRIER_TIMEOUT_MS` → `index.ts:309`。
- `pendingRepairIds` → `index.ts:4736`；`drainingAnswerDiscards` → `index.ts:801`；
  `REPAIR_BARRIER_TIMEOUT_MS` 的 repair while-loop → `index.ts:2162`（deadline）/
  `:2164`（while），`awaitDiscardDrain` 调用 → `:2150`。

定向测试覆盖（合并树仍通过）：repair barrier await / `repairPending` view、
`>8` chained repairs、cold child unknown → view repairPending + prompt 拒绝、
in-flight drain 可见性与 30s deadline / abort 释放 admission、queued-unknown restore/drop、
stale durable discard repair（pending/presented/claimed）、genuine reject 不 repair、
negative control（`>8` queued-row repair 链）。

## 历史证据

冷分支的 `docs/e2e-evidence/phase1d-cold-discard-*`（r1、r3–r9 日志与 `.md`）按原样保留，
未删除、未覆盖；本轮合并证据另存为 `phase1e-merge-*`。

## 残余风险 / 未覆盖

- v1→v2 storage schema 的真实 backend 迁移仍只由 fake open-time parse 测试核对（沿用冷分支
  各轮的显式声明）；E2E 不构造 in-flight drain / repair barrier 场景，该窗口由 vitest 覆盖。
- `answerSeq` 之前写入的 legacy 无序号记录按 log 顺序 tie-break；真实旧数据路径未在 E2E 构造。
- 合并轮只证明双方行为共存；发布前仍需按 `docs/PUBLISHING.md` 在最终 tag 上重跑完整组合。
