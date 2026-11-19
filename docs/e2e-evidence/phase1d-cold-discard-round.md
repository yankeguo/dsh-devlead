# Phase 1d cold-discard durable 修复轮 — E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1157 tests** + 7 构建产物）、
  `node scripts/check-packages.mjs` → `OK (6 packages)`。
- E2E：本轮三条流全部实测并留存日志——
  `pnpm e2e`（patch）、`pnpm e2e --flow installed --no-build`、
  `pnpm e2e --no-worktree --no-build`，均 **PASS**。

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

每阶段总数已 pin（`EXPECTED_CHECKS = { phase1: 27, phase1b: 12, phase2: 23, phase3: 126 }`）。

## 本轮修复点（cold-discard durable）

- discard 队列落 `devlead_report_outbox` 的新 `answer_discards` 表
  （spec version 2，`compatibleVersions:[1]`）；真实 storage-json backend 上
  v1 旧行原样可读、新表按需创建——installed/patch 两流的 outbox 相关 check 全 PASS。
- Host 重启 rehydrate 队列；cold lead + 空 tracker 时从 message source / child
  durable inbox log 派生 discard（sessionQuery 读 persisted audit，无 query 则
  defer 到 lead live）。
- live append/flush 失败入 durable retry；lead live、下一次 prompt 前、5s 定时器 drain。
- `answerSeq` 选 latest（fold stateVersion 4→5），延迟旧 discard 不压新 re-answer。
- 队列溢出/无 storage 显式 warning；disabled→enabled 也 drain；reset 清队列；
  `answeredAt ?? at` view fallback。

新增单测/集成覆盖（`packages/devlead/tests/`）：重启 cold 队列 drain、query/defer
两条 cold 派生路径、child log turn/end 重建、live append-failure drain、延迟旧
discard + re-answer 顺序（含 restart）、flush-failure retry（含 restart）、
队列 >128、disabled→enabled、reset、late claim/discard、legacy answeredAt fallback、
observer splice 语义与 outbox 队列 schema/compat。

## 日志

- [phase1d-cold-discard-patch.log](phase1d-cold-discard-patch.log)
- [phase1d-cold-discard-installed.log](phase1d-cold-discard-installed.log)
- [phase1d-cold-discard-no-worktree.log](phase1d-cold-discard-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。
上一轮证据见 [phase1d-fix-round.md](phase1d-fix-round.md)。
