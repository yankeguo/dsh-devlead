# Phase 1d cold-discard 收口轮（round 8）— in-flight drain 并发窗口修复证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 代码树：worktree `dsh-a673526c-9a26`，父提交 `6deb178`（round 7）+ 本轮修复；
  门禁与三条 E2E 都在该最终树上重跑。
- 门禁：`pnpm verify` → typecheck 通过、**28 文件 / 1211 tests passed**、build **6 targets**；
  `pnpm check:packages` → `OK (6 packages)`。
- E2E：三条流全部实测，退出码由 runner 写入各自日志末尾，均 **PASS（exit 0）**。

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

- patch：`PATCH_EXIT=0`，`188/188`，日志 [phase1d-cold-discard-r8-patch.log](phase1d-cold-discard-r8-patch.log)
- installed：`INSTALLED_EXIT=0`，`188/188`，日志 [phase1d-cold-discard-r8-installed.log](phase1d-cold-discard-r8-installed.log)
- no-worktree：`NOWORKTREE_EXIT=0`，`165/165`，日志 [phase1d-cold-discard-r8-no-worktree.log](phase1d-cold-discard-r8-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。退出码不是手写：
它们由执行命令的 shell 在 E2E 结束后追加到日志末尾。

## Blocker：in-flight drain 期间 queued unknown 不可见

失败路径：lead cold 时 discard 只进入 `pendingAnswerDiscards`（无 mark）；lead live 后
`seedAnswersForAgent` 触发 `void reconcileAnswerDiscards`；drain 一开始就把 queue 从 map 删除，
随后 `await survivalProof`（可挂起）。在这个窗口里 prompt 的旧判断只看
`pendingAnswerDiscards.has(leadId)`，会跳过 in-flight drain；barrier 没有该行，view/health
也看不到，于是 guard 可能放行一条新 answer，而 child 里旧 answer 仍 pending。

修复：

- **A. prompt 无条件等待**：`promptSession` 的 admission 现在直接
  `await this.reconcileAnswerDiscards(leadId)`（[packages/devlead/src/index.ts:2101](../../packages/devlead/src/index.ts#L2101)）。
  `reconcileAnswerDiscards` 本身复用 per-lead in-flight promise（`answerDiscardDrains`），无队列时
  立即返回；因此既等待已存在的 drain，也不改变无队列路径的语义。后续 repair barrier 与
  post-check 保留。
- **B. drain 期间可见**：drain 删除 queue 后把同一个数组发布到新的
  `drainingAnswerDiscards` map（[field:768](../../packages/devlead/src/index.ts#L768)、
  [wrapper:5073](../../packages/devlead/src/index.ts#L5073)），并在 `finally` 清理；实际 drain
  拆到 `drainAnswerDiscardsNow`，保证所有 early return 也处于 `finally` 覆盖内。
  `pendingRepairIds` 扫描该快照（[4670](../../packages/devlead/src/index.ts#L4669)），
  `answerDiscardHealth` 的 lead 集合也加入该 map（[4208](../../packages/devlead/src/index.ts#L4208)）。
  in-flight drain 的行按定义尚未得到 survival 结论，因此在 drain 期间**一律**计入；对尚未开始
  drain 的普通 queued row，仍保留“只有 child 不可读才计入”的既有语义（避免误标可安全
  supersede 的可读 child row）。
- 并发测试：[prompt waits for an in-flight drain...](../../packages/devlead/tests/service.spec.ts#L7560)
  使用 `FakeSessionQuery.readSession` 挂起，构造 lead 持久 admitted + tracker discarded + 无 mark
  queued row；断言：
  - drain 挂起期间 prompt **不 settle**；
  - `answerDiscardHealth().pending` 已为 0，但 `pendingRepairs >= 1`，`questionAnswerView.repairPending === true`；
  - release 后 drain 返回 unknown，prompt 以 `DEVLEAD_SESSION_UNAVAILABLE` 拒绝，message 指向
    pending answer-discard repair；
  - 不产生第二条 admitted answer record、不投递新输入；
  - child 恢复可读后同文本 retry 幂等返回原 `messageId`。
  测试按“Host 无 controller”路径接受 guard 拒绝（guard 在 activator 选择之前），不伪造 resume。
- 负向对照（临时回退单点，脚本化）：
  - 只回退 A（恢复 `if (pendingAnswerDiscards.has(leadId))`）→ 同一测试失败：
    `AssertionError: expected true to be false`（prompt 在 drain 完成前就 settle）。
  - 只回退 B（从 `pendingRepairIds` / health lead 集合移除 `drainingAnswerDiscards`）→ 同一测试
    失败：`pendingRepairs[leadId]` 为 undefined（view/health 漏报）。
  恢复最终代码后同一测试通过。

## Nit：genuine settle 清 repair failure

`repairDisprovenDurableDiscards` 的 `survival === undefined`（child 已 settle、discard 为真）
分支现在同时 `clearRepairFailure(record)` 与 `clearRepairPending`（[5013](../../packages/devlead/src/index.ts#L5013)）。
测试 [a genuine settle clears a prior repair failure](../../packages/devlead/tests/service.spec.ts#L7661)：
先制造一次 append 失败（`lastRepairFailure` 命中 m1），随后移除 pending answer 让 child 真实
settle，再执行 scan；断言 `lastRepairFailure` 清空。deferred retry entry 仍会让
`pendingRepairs` 保持 1，这是 retry 仍待执行，不是 failure 残留。

## 证据 nit：退出码

r7 的日志末尾没有 shell exit code；本轮三条 E2E 均以
`command > log 2>&1; echo "<FLOW>_EXIT=$?" >> log` 生成，日志末尾分别是
`PATCH_EXIT=0`、`INSTALLED_EXIT=0`、`NOWORKTREE_EXIT=0`（见上方链接）。
[r7 证据](phase1d-cold-discard-r7.md) 已加说明指向本轮日志。

## 未覆盖 / 残余风险

- prompt 对 in-flight drain 的等待没有单独 deadline；如果 composing 的 `sessionQuery.readSession`
  永不 resolve，prompt 会一直等待（与 drain 本身同寿命）。repair barrier 的 30s deadline 只覆盖
  barrier，不覆盖 drain。本轮按终审要求实现“无条件等待”，未新增 drain 超时。
- E2E 不专门构造 in-flight drain 场景；该窗口由上述 vitest 覆盖。
- v1→v2 storage schema 迁移仍只由 fake open-time parse 测试核对；真实 backend 上已有 v1 数据的
  迁移路径未覆盖（沿用前几轮声明）。
- `pnpm verify` 的 1211 tests = r7 的 1209 + 本轮 2 条（in-flight drain、genuine settle failure）。

上一轮证据见 [phase1d-cold-discard-r7.md](phase1d-cold-discard-r7.md)。
