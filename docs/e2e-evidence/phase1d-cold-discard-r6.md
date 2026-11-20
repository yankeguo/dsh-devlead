# Phase 1d cold-discard 收口轮（round 6）— E2E 证据

- 基线运行时：安装版 **DeepSeek Harness 0.2.2-rc.5**（`dsh` on PATH）。
- 门禁：`pnpm verify`（typecheck + **28 文件 / 1206 tests** + 7 构建产物）、
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

## 本轮收口点（DeepSeek 对 6afa6d3 的复核，1e 前置 major）

- **tool repairPending 透传**：`REPORT_SCHEMA` 加 `repairPending: boolean`，`reportValue` 透传
  `answerView.repairPending`；`devlead_get_session`/`devlead_notifications` 消费者可见（tool 单测）。
- **prompt repair barrier 收口**：await barrier **直到无 in-flight**（非固定 8 轮，>8 repair 也等完），
  再查 deferred/repairPending，仍 pending 则以 `DEVLEAD_SESSION_UNAVAILABLE` 可重试拒绝本次 answer；
  drain/restore/drop 触发的 repair 同链；tracker 仅在 durable append+flush **成功后** advance
  （失败 view 保持 repairPending，不抢先 answered）。
- **cold child + 无 query/log 的 unknown 态**：`survivalProof` 返回 `unknown`，`questionAnswerView`
  标 `repairPending:true`，prompt 拒绝（不静默接受重复 answer），defer 到 child live 重试。
- **MINOR**：`repairingQuestions` 扫描到 latest terminal 即标记、resolve 才清；`lastRepairFailure`
  按 lead+message 记录（其它 message 的成功/drop-only 不清）；`pendingRepairs` 合并
  in-flight/deferred/unknown。

## 兼容覆盖说明（v1→v2，保留缺口）

v1→v2 的 open-time schema/版本兼容由 fake open-time parse 测试与 rc.5 storage-json 源码语义
（acceptedStamps = current + compatibleVersions、按表目录加载）核对。**e2e 使用全新 throwaway
profile，不覆盖真实 backend 上已有 v1 数据的迁移路径**；本 workspace 无法解析
storage-json/sqlite backend 依赖（未新增依赖），故未做真实 backend 升级 smoke，发布说明保留此缺口。

## 日志

- [phase1d-cold-discard-r6-patch.log](phase1d-cold-discard-r6-patch.log)
- [phase1d-cold-discard-r6-installed.log](phase1d-cold-discard-r6-installed.log)
- [phase1d-cold-discard-r6-no-worktree.log](phase1d-cold-discard-r6-no-worktree.log)

3 条 SKIP 为无 provider 凭据的正向模型选择检查（打印真实原因，不伪造）。
上一轮证据见 [phase1d-cold-discard-r5.md](phase1d-cold-discard-r5.md)。
