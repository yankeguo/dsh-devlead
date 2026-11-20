# Phase 1d cold-discard 复核修复轮（round 5）— E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1200 tests** + 7 构建产物）、
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

## 本轮修复点（DeepSeek 对 78e1e55 的复核）

- **BLOCKER deferred repair 用旧 survival**：`runDiscardRepair` 处理时重新 `survivalProof`
  （child 可能已 settle）；仅当 latest 是**同一个 stale terminal**（同 messageId/status/answerSeq
  且 `latest.at <= stale.at`）才 append repair；newer genuine terminal（true reject/clear-all）
  绝不被覆盖。
- **BLOCKER/MAJOR repair fire-and-forget 抢跑**：每个 repair pass/fact 链入 per-lead
  `answerRepairBarriers`；`promptSession` 在 question guard 前 await barrier（并先处理 deferred
  repairs）；`questionAnswerView` 对正在 repair/deferred 的 question 标 `repairPending:true`
  （protocol `DevLeadQuestionAnswerView` 新增可选字段），UI 不把 stale terminal 当最终 open。
- **MAJOR seed admitted 无 at 保护**：seed same-message terminal 对 admitted 也要求
  `answer.at > existing.at`；`resolvedAnswer` 对 entry admitted/claimed 且 `entry.at > record.at`
  保留 entry。
- **MAJOR repair 失败/health**：health 增加 `pendingRepairs` 与分离的 `lastRepairFailure`
  （repair append/flush），`lastFailure`（discard 队列）独立；drop-only drain 清 lastFailure 但
  不清仍失败的 repair；补 cold defer→live retry、repair append/flush failure→health→retry、
  repair success clear、drop-only 与 repair failure 并存测试。
- **MINOR**：`dropObsoleteDiscard` 的 tracker repair 移到 latest 校验通过之后（成功 repair 显式
  advance 到 proven status，失败/被拒不留 falsely-survived tracker）；repairStale latest 校验
  比较 at/answerSeq/status；`repairLifecycle` forward-only（admitted→claimed→presented，永不
  回退 presented）。

## 兼容覆盖说明（v1→v2，保留缺口）

v1→v2 的 open-time schema/版本兼容由 fake open-time parse 测试与 rc.5 storage-json 源码语义
（acceptedStamps = current + compatibleVersions、按表目录加载）核对。**e2e 使用全新 throwaway
profile，不覆盖真实 backend 上已有 v1 数据的迁移路径**；本 workspace 无法解析
storage-json/sqlite backend 依赖（未新增依赖），故未做真实 backend 升级 smoke，发布说明保留此缺口。

## 日志

- [phase1d-cold-discard-r5-patch.log](phase1d-cold-discard-r5-patch.log)
- [phase1d-cold-discard-r5-installed.log](phase1d-cold-discard-r5-installed.log)
- [phase1d-cold-discard-r5-no-worktree.log](phase1d-cold-discard-r5-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。
上一轮证据见 [phase1d-cold-discard-r4.md](phase1d-cold-discard-r4.md)。
