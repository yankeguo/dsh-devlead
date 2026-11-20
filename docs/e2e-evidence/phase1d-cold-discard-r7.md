# Phase 1d cold-discard 收口轮（round 7）— 验证与 E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 代码树：worktree `dsh-a673526c-9a26`，父提交 `a365515`（round 6）+ 本轮 WIP；
  全部门禁与 E2E 都在该最终树上重跑（不是复用 round 6 结果）。
- 门禁：`pnpm verify` → typecheck 通过、**28 文件 / 1209 tests passed**、build **6 targets**；
  `pnpm check:packages` → `OK (6 packages)`。
- E2E：三条流全部在本轮最终树上实测并留存日志，均 **PASS**；当轮日志末尾未写 shell
  exit code，r8 重跑已把真实退出码写入新日志（见 [r8 证据](phase1d-cold-discard-r8.md)）。

## 汇总

```
patch / installed（各）:
  phase 1 (default profile):                 27/27
  phase 1b (cold lead rehydration):          12/12
  phase 2 (experimental worktree):           23/23
  phase 3 (close/dispatch/triage + 1d):     126/126   (123 PASS + 3 credential-less SKIP)
  total:                                    188/188

--no-worktree（patch，跳过 phase 2）:
  total:                                    165/165
```

- patch：`PATCH_EXIT=0`，`188/188`，日志 [phase1d-cold-discard-r7-patch.log](phase1d-cold-discard-r7-patch.log)
- installed：`INSTALLED_EXIT=0`，`188/188`，日志 [phase1d-cold-discard-r7-installed.log](phase1d-cold-discard-r7-installed.log)
- no-worktree：`NOWORKTREE_EXIT=0`，`165/165`，日志 [phase1d-cold-discard-r7-no-worktree.log](phase1d-cold-discard-r7-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。

## 本轮收口点

### A. blocker：queued discard 的 unknown 态

- `pendingRepairIds(leadId)` 成为唯一集合：in-flight `repairingQuestions` + deferred
  `deferredDiscardRepairs` + **仍在 `pendingAnswerDiscards` 且 child 同步不可读
  （`childUnreadable`）的 queued row** + durable terminal 且 child 不可读的 latest record。
  `questionRepairPending` 与 `answerDiscardHealth().pendingRepairs` 都调用它（同源）。
- `restoreAnswerDiscards` 的 unknown 分支与 drain（`reconcileAnswerDiscards`）的 unknown 分支
  显式 `markRepairPending`；drain append+flush 成功、`dropObsoleteDiscard` 的 supersede、
  `runDiscardRepair` 的 genuine settle 分别清理 mark（和该 message 的 repair failure）。
- `promptSession` 在 drain 之后、question policy guard 之前重查 `questionRepairPending`；queued
  unknown 仍 pending 时以 `DEVLEAD_SESSION_UNAVAILABLE` 可重试拒绝，不消费新 answer。
- 覆盖测试：`a queued discard with an unreadable child is repairPending: view, health, and prompt refusal`
  （outbox 预置 stale row + child 无 Session/query → view/health/prompt；child live 后重新
  admission 成功）。

### B. major：真实链路的 >8 repair 与 negative control

- 新测试 `prompt awaits more than eight queued-row repairs spawned through the restore/drop chain`
  不再只走 durable stale 路径：10 条 queued row 全部在 child cold 时由 `restoreAnswerDiscards`
  恢复；随后逐次把一个 child 变 live，经 `reconcileQueuedDiscardsForChild` →
  `dropObsoleteDiscard` → `repairStaleDurableDiscard` 每轮只 spawn 一条 repair；prompt 在
  barrier 上等待全部 10 代 repair。每个 flush 由测试 gate，确保“下一代 repair 已入 barrier、
  当前代尚未完成”的交错顺序，不会一次性注册全部 repair。
- negative control（脚本化，临时改回 round 5 的固定 8 轮 barrier）：

  ```text
  for (let round = 0; round < 8; round += 1) {
    const barrier = this.answerRepairBarriers.get(leadId)
    if (barrier === undefined) break
    await barrier
  }
  ```

  `pnpm exec vitest run packages/devlead/tests/service.spec.ts -t "prompt awaits more than eight queued-row repairs"`
  → **FAILED**（`AssertionError: expected true to be false`，第 8 代释放后 prompt 已提前 settle）。
  恢复最终 `while (barrier !== undefined)` + `REPAIR_BARRIER_TIMEOUT_MS` 逻辑后同一命令
  → **PASSED**。最终树 grep 确认 `REPAIR_BARRIER_TIMEOUT_MS` / `awaitRepairBarrier` /
  `while (barrier !== undefined)` 存在、`round < 8` 不存在。

### C. nits

- C1：`devlead_get_session` 的 `repairPending` 断言去掉 `if (reports !== undefined)`；tool 测试
  显式断言 `reports` 存在且首条带 `repairPending: true`。
- C2：`repairFailures` 值改为 `{ message, at }`；超过 `MAX_PENDING_ANSWER_DISCARDS` 时按时间
  淘汰最旧；`lastRepairFailure` 取最新失败；genuine settle / supersede / 成功 repair 清理该
  message 的 entry。
- C3：barrier while 增加 `REPAIR_BARRIER_TIMEOUT_MS`（30s）deadline；`awaitRepairBarrier` 同时
  监听 prompt 的 AbortSignal，超时/取消都抛 `DEVLEAD_SESSION_UNAVAILABLE` 可重试错误，并清理
  timer/listener。测试 `an aborted prompt leaves a blocked repair barrier with a retryable error`
  覆盖取消路径。

## 未覆盖 / 残余风险

- 30s 超时本身未用真实等待或 fake timer 做端到端测试（取消路径已测；超时与取消共用同一
  `awaitRepairBarrier` 退出逻辑）。
- 新增的 queued-unknown 判定使用同步 `childUnreadable`；composed `sessionQuery` 的异步读取失败
  仍由 repair pass 的 `survivalProof` → defer 处理，不在 view 同步阶段判定。
- v1→v2 的 open-time schema/版本兼容仍只由 fake parse 测试与 rc.5 storage-json 源码语义核对；
  E2E 使用全新 throwaway profile，**不覆盖**真实 backend 上已有 v1 数据的迁移路径（本
  workspace 无法解析 storage-json/sqlite backend 依赖，未新增依赖）。
- E2E 是真实 Host 的端到端回归，不针对新增的 queued-unknown 单元/集成路径构造专属场景；
  该路径由上述 vitest 覆盖。
- `pnpm verify` 的 1209 tests 比 round 6 的 1206 多 3 条：queued-unknown、真实 >8 repair 链、
  abort barrier 各一条。

上一轮证据见 [phase1d-cold-discard-r6.md](phase1d-cold-discard-r6.md)。
