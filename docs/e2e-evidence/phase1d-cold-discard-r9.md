# Phase 1d cold-discard 收口轮（round 9）— 有界 drain 等待证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 代码树：worktree `dsh-a673526c-9a26`，父提交 `268eb29`（round 8）+ 本轮修复。
- 门禁：`pnpm verify` → typecheck 通过、**28 文件 / 1213 tests passed**、build **6 targets**；
  `pnpm check:packages` → `OK (6 packages)`。
- E2E：三条流均在最终树上实测，退出码由 runner 追加到日志末尾，均 **PASS（exit 0）**。

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

- patch：`PATCH_EXIT=0`，`188/188`，[日志](phase1d-cold-discard-r9-patch.log)
- installed：`INSTALLED_EXIT=0`，`188/188`，[日志](phase1d-cold-discard-r9-installed.log)
- no-worktree：`NOWORKTREE_EXIT=0`，`165/165`，[日志](phase1d-cold-discard-r9-no-worktree.log)

## Major：in-flight drain await 的 liveness 回归

r8 的 admission 无条件 `await reconcileAnswerDiscards`，但复用的 in-flight drain 没有
deadline、也没接 prompt 的 `options.signal`；`sessionQuery.readSession` 永不 resolve 时 prompt
永不 settle，`withTargetAdmission` 的 target tail 也不释放。本轮修复：

- 新增 `ANSWER_DISCARD_DRAIN_TIMEOUT_MS = 30_000`（[index.ts:306](../../packages/devlead/src/index.ts#L306)）。
- 抽出通用 `awaitBounded(run, ms, signal, errorFor)`（[index.ts:4817](../../packages/devlead/src/index.ts#L4817)），
  `awaitRepairBarrier` 与新的 `awaitDiscardDrain`（[index.ts:4799](../../packages/devlead/src/index.ts#L4799)）
  共用同一套 timer/abort/cleanup 逻辑；drain 的超时/取消错误文案为
  `answer-discard drain did not settle (...)`，错误码仍是可重试的
  `DEVLEAD_SESSION_UNAVAILABLE`。
- `promptSession` 的等待逻辑（[index.ts:2114](../../packages/devlead/src/index.ts#L2114)）：
  - **answer** admission 总是等待 queued 或 in-flight drain（保留 r8 A/B 语义）；
  - 其它 intent（instruction/background）仅在**本次 prompt 自身有 queued rows** 时等待，
    因此不会被别的 trigger 启动的 in-flight drain 阻塞（修复 reviewer 的 liveness 关切的
    无关流量部分）；
  - 等待有 30s deadline + `options.signal`；超时/取消只放弃等待，drain 继续后台执行；
  - 对 race 输掉后 drain 的后续 reject 显式挂 `catch(() => undefined)`，避免 unhandled
    rejection；`withTargetAdmission` 的 finally 在抛错时释放 tail。

### 测试

- [abort 测试](../../packages/devlead/tests/service.spec.ts#L7791)：
  挂起 `readSession` → answer prompt 进入 drain wait → abort → 及时
  `DEVLEAD_SESSION_UNAVAILABLE`，message 含 `drain did not settle (cancelled)`；
  在 drain 仍挂起时把 target 变 live 并成功投递一条 instruction，证明 target admission tail
  已释放；释放 read 后后台 drain 完成，row 重新入队并标记 provisional，且只有一条 admitted
  answer record。
- [deadline 测试](../../packages/devlead/tests/service.spec.ts#L7836)：
  `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`；prompt 挂起后
  `vi.advanceTimersByTimeAsync(30_001)`，断言及时出现
  `drain did not settle (timed out)`、无 admission；释放 read 后 drain 仍在后台完成，
  `pending`/`pendingRepairs` 可见、只有一条 admitted record，且无 unhandled rejection。
  测试实际耗时约 17ms，不是真实等待 30s。
- r8 的 release-path 并发测试与全部既有测试（包括
  `a live-lead discard append failure drains before the next prompt`）保持通过。后者明确了
  instruction prompt 也要 drain 自己 queued rows 的既有契约，因此本轮保留“其它 intent 有
  queued rows 时等待、只跳过别人的 in-flight drain”的混合策略，而非完全 answer-only。

## 未覆盖 / 残余风险

- drain 本身仍不可取消：若 `sessionQuery.readSession` 永不 resolve，后台 drain 和
  `drainingAnswerDiscards` 快照会一直存在；answer admission 会每 30s 超时拒绝（可重试），
  instruction/background 不再被它阻塞。彻底解决需要 query 层取消/超时，超出本轮 1d 范围。
- E2E 不构造 in-flight drain 场景；该窗口由新增 vitest 覆盖。
- v1→v2 storage schema 迁移仍只由 fake open-time parse 测试核对，真实 backend 已有 v1 数据的
  迁移路径未覆盖（沿用前几轮声明）。
- 测试数：1213 = r8 的 1211 + 本轮 abort/timeout 两条。

上一轮证据见 [phase1d-cold-discard-r8.md](phase1d-cold-discard-r8.md)。
