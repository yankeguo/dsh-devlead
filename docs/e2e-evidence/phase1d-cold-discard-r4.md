# Phase 1d cold-discard 复核修复轮（round 4）— E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1192 tests** + 7 构建产物）、
  `node scripts/check-packages.mjs` → `OK (6 packages)`。
- E2E：三条流全部实测并留存日志——`pnpm e2e`（patch）、
  `pnpm e2e --flow installed --no-build`、`pnpm e2e --no-worktree --no-build`，均 **PASS**。

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

## 本轮修复点（DeepSeek 对 85f2193 的复核）

- **BLOCKER claimed 不是 survival 状态**：observer 暴露 `isClaimed/claimedAtOf`；tracker
  `entry.status === 'claimed'` 且 `discard.at < entry.at` 视为 survival；`repairLifecycle`
  支持 claimed/at；live/cold 两条 survival 路径都补 claimed；observer 缺失时回退 child log
  replay。claim 晚于 discard 才算 survival，晚于 claim 的 terminal 是 genuine pre-step reject。
- **BLOCKER lead-log stale durable discard 无法修复**：`resolvedAnswer` same-message presented
  优先于 durable terminal，claimed 与 durable terminal 按 `at` 比较；survival 证明后追加一条
  **durable repair fact**（同 message/answerSeq、proven status、严格更晚 at），fold 重新派生
  answered，restart 后仍 answered；lead cold 时 repair defer 到 lead live，append/flush 失败
  re-defer + retry timer + health。
- **MAJOR seed same-message 只排除 presented**：claimed entry 只被 claim 之后的 terminal 覆盖；
  `repairLifecycle` 接受 claimed/presented 的 at。
- **MINOR**：drop-only drain（只 drop stale、无 append）清除 `lastAnswerDiscardFailure`；
  survivalProof 内部 observer 带 eviction warning sink；首事件即 canceled 的 replay/live 测试；
  legacy 无 seq 的 re-answer + late discard + claimed tie 按 durable log position。

## 兼容覆盖说明（v1→v2，保留缺口）

v1→v2 的 open-time schema/版本兼容由 fake open-time parse 测试与 rc.5 storage-json 源码语义
（acceptedStamps = current + compatibleVersions、按表目录加载）核对。**e2e 使用全新 throwaway
profile，不覆盖真实 backend 上已有 v1 数据的迁移路径**；本 workspace 无法解析
storage-json/sqlite backend 依赖（未新增依赖），故未做真实 backend 升级 smoke，发布说明保留此缺口。

## 日志

- [phase1d-cold-discard-r4-patch.log](phase1d-cold-discard-r4-patch.log)
- [phase1d-cold-discard-r4-installed.log](phase1d-cold-discard-r4-installed.log)
- [phase1d-cold-discard-r4-no-worktree.log](phase1d-cold-discard-r4-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。
上一轮证据见 [phase1d-cold-discard-r3.md](phase1d-cold-discard-r3.md)。
