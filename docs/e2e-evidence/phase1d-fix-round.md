# Phase 1d 复核修复轮 — E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1119 tests** + 7 构建产物）、
  `node scripts/check-packages.mjs` → `OK (6 packages)`。
- E2E：`pnpm e2e`（patch）与 `pnpm e2e --flow installed` 均 **PASS**。

## 汇总（两 flow 一致）

```
phase 1 (default profile):                 27/27
phase 1b (cold lead rehydration):          12/12
phase 2 (experimental worktree):           23/23
phase 3 (close/dispatch/triage + 1d):     126/126   (123 PASS + 3 credential-less SKIP)
total:                                    188/188
```

`--no-worktree` 调试组合为 165/165（阶段 1 + 1b + 3）。每阶段总数已 pin
（`EXPECTED_CHECKS = { phase1: 27, phase1b: 12, phase2: 23, phase3: 126 }`）。

## Phase 1d answer checks（14 条，全 PASS）

answer-turn（真实 scripted child turn，rc.5 agent-loop 事件）：
- scripted answer-turn probe settles success with a real child log
- answer steers the running child next-step with a wake and echoes question_id
- same-key/same-text answer retry returns the original receipt; a different answer conflicts
- answer is presented in a later real step after the question batch, before the single completed turn/end
- second model request really saw the answer text
- durable answer record is admitted and the derived view reports answered/presented
- answered question reached the lead digest and action-required wake

answer-inbox（真实 durable inbox + workspace/session-stop fan-out）：
- answer-inbox probe settles success with metadata/clear-own/clear-all facts
- answer steers a running child next-step and the derived view reports answered/admitted
- queuedInputs carries the answer intent/questionId/wakeRequested/deliveryState
- retract refuses the answer but accepts background and instruction; the answer stays pending
- background injects next-step without requesting a wake
- clear-own keeps the pending answer and human input, drops the own instruction, question stays answered
- clear-all discards the pending answer, reopens the question, and records the discard durably

完整 patch flow 日志见 [phase1d-fix-round-patch.log](phase1d-fix-round-patch.log)。
3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。