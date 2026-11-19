# Phase 1d cold-discard 复核修复轮（round 3）— E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1178 tests** + 7 构建产物）、
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

## 本轮修复点（DeepSeek 对 c44c358 的复核）

- **BLOCKER canceled+restore 误 discard**：observer 把 canceled 移除记为 cancellation
  候选；同 id 重新 insert（keep/clear-own restore）或 `user/message`（presented）撤销候选；
  replay 在日志末尾才 finalize（日志止于 interrupt 窗口内则保持 pending），live 观测在窗口外
  首个 `turn/end` finalize。`discardPendingAnswer` 写前查 `locatedInputs`/presented；
  drain/rehydrate/child 激活做 survival 证明（cold child replay 其 durable log），stale 行
  丢弃并修复 tracker。
- **MAJOR observer 重新激活不 replay**：每次 `agent/created` 全量 replay（live→cold→live
  补放），`agent/disposed` 清 observer。
- **MAJOR seed 回退 presented / restore 无过滤**：seed 永不把 presented 回退成 discarded；
  restore 按 survival/answerSeq 过滤 stale 行，128 bounded + overflow warning。
- **MINOR**：`answer_discards` 单独 30 天 retention + 显式告警（不按普通 outbox 7 天静默
  prune）；`answerDiscardHealth()` 暴露 per-lead pending + lastFailure（flush 失败不只进
  logger）；claimed/candidate/presented/observer eviction warning；legacy 无 seq 的
  different-answer 同瞬 tie 按 durable log position（admission 优先，lifecycle 事实永不压过）。

## 兼容覆盖说明（v1→v2）

v1→v2 的 open-time schema/版本兼容由 fake open-time parse 测试与 rc.5 storage-json 源码语义
（acceptedStamps = current + compatibleVersions、按表目录加载）核对。**e2e 使用全新 throwaway
profile，不覆盖真实 backend 上已有 v1 数据的迁移路径**；本 workspace 无法解析
storage-json/sqlite backend 依赖（未新增依赖），故未做真实 backend 迁移测试，显式声明此缺口。

## 日志

- [phase1d-cold-discard-r3-patch.log](phase1d-cold-discard-r3-patch.log)
- [phase1d-cold-discard-r3-installed.log](phase1d-cold-discard-r3-installed.log)
- [phase1d-cold-discard-r3-no-worktree.log](phase1d-cold-discard-r3-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。
上一轮证据见 [phase1d-cold-discard-round.md](phase1d-cold-discard-round.md)。
