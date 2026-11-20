# Batch 1：breaking compatibility cleanup + correctness / UI evidence

日期：2026-11-20（Asia/Shanghai）
基线：`main @ a21c7b7c1a4269b36af747bed808c7cd4a52ffe2`
运行 DSH：安装版 **0.2.2-rc.5**；源码契约另以只读 `git show dsh-v0.2.2-rc.1:<path>` /
`dsh-v0.2.2-rc.5:<path>` 核对，未 checkout、修改或更新 DSH。

## 冻结树与时间线

| 时间 | 事实 |
| --- | --- |
| 16:19 | 确认 `main @ a21c7b7`、工作区干净；Batch 1 开始，未改 version/tag、未 push |
| 17:18 | `pnpm verify`：34 files / **1394 tests** 全过，7 个入口 build 成功（6 targets） |
| 17:18 | `pnpm check:packages`：**OK (6 packages)**；`git diff --check` 通过 |
| 17:21–17:23 | 三条首轮真实 e2e 全过；最终 diff 复核后再跑 `pnpm verify` 重建冻结候选 |
| 17:23 | 最终 `pnpm verify` 再次 34/1394 全过，`check:packages` 再次 OK |
| 17:25:12 | 最终 patch 完成：**221/221，PATCH_EXIT=0** |
| 17:25:56 | 最终 installed 完成：**221/221，INSTALLED_EXIT=0** |
| 17:27:05 | 首轮最终 no-worktree 完成：**198/198，NO_WORKTREE_EXIT=0** |
| 17:49–17:59 | 3 项问题及后续 2 个边界修复后，`pnpm verify`：34 files / **1400 tests** 全过，`check:packages` 再次 OK |
| 17:59:57 | blocker-fixed patch：**221/221，PATCH_EXIT=0** |
| 18:00:35 | blocker-fixed installed：**221/221，INSTALLED_EXIT=0** |
| 18:01:21 | blocker-fixed no-worktree：**198/198，NO_WORKTREE_EXIT=0** |

blocker-fixed 最终 e2e 的 client revision 为 `43730085e68b`。命令与真实输出：

```text
$ pnpm e2e --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27
  phase 1b: 12/12
  phase 2: 23/23
  phase 3: 128/128
  phase 1e: 31/31
  total: 221/221 checks
PATCH_EXIT=0

$ pnpm e2e --flow installed --no-build
E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27
  phase 1b: 12/12
  phase 2: 23/23
  phase 3: 128/128
  phase 1e: 31/31
  total: 221/221 checks
INSTALLED_EXIT=0

$ pnpm e2e --no-worktree --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27
  phase 1b: 12/12
  phase 3: 128/128
  phase 1e: 31/31
  total: 198/198 checks; phase 2 skipped (--no-worktree)
NO_WORKTREE_EXIT=0
```

日志分别保留在本机 `/tmp/dsh-devlead-batch1-final3-{patch,installed,no-worktree}.log`。
早期一次 `pnpm e2e -- --no-build` 因多余参数分隔符被 CLI 以 `unknown argument: --` 拒绝，
不是产品执行，未计入上述证据；纠正为仓库文档命令后重跑。

## Batch 1 negative control / mutation coverage

| 场景 | 证明 | 结果 |
| --- | --- | --- |
| 合法 v1 record / 无 seq answer | `fold.spec.ts`：旧 envelope 在三个 projection 中只 warning 一次，随后当前 v2 正常 fold | 忽略且**不冻结**，旧状态失效 |
| 当前 v2 payload 损坏 / 旧 v5 cache | `fold.spec.ts`、`service.spec.ts`、`notification.spec.ts` | 当前 payload `failure` 冻结，合法 `/devlead reset` 解冻；无 `repairPending` 的 parent stateVersion 5 cache row schema 拒绝并失效重折（stateVersion 7） |
| v1/v2 outbox 与无 origin row | `outbox.spec.ts`：v3 declaration、reopen、打开后 legacy row、open failure | 版本戳不接受时读作 absent、文件保留；当前 schema 的无 origin row 才 `backup-and-skip`；domain 禁用并 warning，不 crash、不写坏；discard 30 天 retention 不变 |
| foreign / multiple supervisor | `phase2.spec.ts` | 分别返回 `DEVLEAD_FOREIGN_SUPERVISOR` / `DEVLEAD_MULTIPLE_SUPERVISORS`，target 无 followup/steer |
| 非 answer 幂等冲突 / 读失败 | `phase2.spec.ts` + `idempotency.spec.ts` | 重启后同 key 同文本返回原 receipt、无第二次投递；不同文本冲突；7 天 TTL；composed storage 打不开及 corrupt/unreadable receipt 均 fail closed、零新投递 |
| correction/background 背压 | `phase2.spec.ts` | 第 5 条 correction、第 9 条 background 返回 `DEVLEAD_DELIVERY_RATE_LIMITED`；原幂等 receipt 可 replay；新 child turn 重置 |
| TTL 边界 / 禁用 / answered / replay / 容量 | `phase2.spec.ts` | `>= TTL` 的 open 过期，answer 拒绝；`0` 仍 open；answered 不过期；cold expired 不 replay；open cold 只 wake 一次；17 条同 pair 问题按 16+1 容量分批全部 delivered；等待中已 answered 的 deferred question 不再 replay |
| 永久挂起的 cold projection read | `service.spec.ts` round 9 + `runtime-projections.spec.ts` | 30 秒放弃且 answer 可重试；两次重试仍只有 **1 次** `observeSession` 调用，不 wedge、不累积 raw Promise |
| deprecated reader 清零 | `runtime-projections.spec.ts` + 全仓 grep | 生产无 `snapshotEvents()` / `eventAt()` / `ownEvents()`；bounded overflow 返回 unknown 而非假 discard |
| repairPending | `fold.spec.ts` repair record + `phase2.spec.ts` 真实 registry listener + `client-ui` render/format tests | `plugin:devlead/repair` 驱动 true→false 双向发布；UI 显示 `open · provisional` / 「待回答 · 暂定」，tool 字段不变 |
| 真实 outbox 写保护 mutation | 最终 patch phase 3 | `durable:false`、`concludesTurn:false`、要求 restatement；恢复写权限后的新 question 为 `durable:true`、`queued:false`，未伪造 replay 成功 |
| 真实 action 容量 negative control | 最终 patch/installed/no-worktree phase 1e | 17 条 distinct action reports 全 durable，第 18 条明确 `DEVLEAD_DELIVERY_RATE_LIMITED`，不静默丢弃 |

## Pin 是否变化

**没有变化**：最终仍是 patch / installed **221/221**、no-worktree **198/198**（其中 3 条模型选择
检查因无凭据按既有原因 SKIP）。Batch 1 的新行为由上述定向 unit/integration tests 覆盖，既有真实
Host 的工具数（14 lead + 1 report）、T1/lane/outbox/answer 合同没有因 breaking 清理改变，因此无需
修改 e2e check pin。

## 残余边界（非未完成项）

- 旧 Session 的 DevLead 状态与 v1/v2 outbox/discard 数据是**有意丢弃**，本批不提供迁移；当前 v2
  损坏仍要求显式 reset。
- correction/background 预算是 Host 进程内、按 child-turn 的 admission 背压，不是跨 Host 进程的持久
  配额账本；durable idempotency 与 pending inbox 仍保留其各自语义。
- `repairPending` 是 runtime repair 集合的 whole-value 投影记录，不是 answer 的 durable 完成证明；
  mark/clear 都经正常 Host publication 推送。answer admission 仍以 runtime repair barrier 为准。

## 复核修复（Batch 1 follow-up）

基线：`a10639ae1fb90e1477e90881f0a467abbc798211`。独立复核给出的 2 个 major 与 minor 均已处理。

### 时间线与真实输出

| 时间 | 事实 |
| --- | --- |
| 19:00:00 | 修复后首轮 `pnpm verify`：34 files / **1411 tests** 全过，6 targets；`check:packages` OK |
| 19:00:33 | M1 mutation（恢复 `invalidRecords:'backup-and-skip'`）：at-rest 测试按预期失败，`M1_MUTATION_EXIT=1`；随后恢复源码 |
| 19:00:59 | M2 fold-level mutation（普通 user/message 重新计入 presented）：当时仅 fold 级用例失败，`M2_MUTATION_EXIT=1`；二次修复新增真实 survivalProof service 负控，不能用该旧日志证明 service 覆盖 |
| 19:01:16 | 恢复后再次 `pnpm verify`：34/1411 全过，`check:packages` OK，`git diff --check` 通过 |
| 19:02:03 | patch：**221/221，PATCH_EXIT=0**，client revision `1bdf1e6e396d` |
| 19:02:41 | installed：**221/221，INSTALLED_EXIT=0** |
| 19:03:16 | no-worktree：**198/198，NO_WORKTREE_EXIT=0** |

最终命令与输出：

```text
pnpm verify
Test Files  34 passed (34)
Tests       1411 passed (1411)
build complete (6 targets)

pnpm check:packages
check-packages: OK (6 packages)

pnpm e2e --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
total: 221/221 checks
PATCH_EXIT=0

pnpm e2e --flow installed --no-build
E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
total: 221/221 checks
INSTALLED_EXIT=0

pnpm e2e --no-worktree --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
total: 198/198 checks; phase 2 skipped (--no-worktree)
NO_WORKTREE_EXIT=0
```

日志：`/tmp/dsh-devlead-batch1-fix-{patch,installed,no-worktree}.log`；
mutation：`/tmp/dsh-devlead-m{1,2}-mutation.log`。

### 修复与新增负控

| 项 | 实现与证明 |
| --- | --- |
| M1 at-rest receipt corruption | 去掉 `PROMPT_IDEMPOTENCY_SPEC.invalidRecords`，open-time 默认拒绝；service 在 store open 前损坏 receipt 后，同 key prompt `DEVLEAD_SESSION_UNAVAILABLE` 且不重复投递。恢复 backup-and-skip 的 mutation 确实使该测试失败 |
| M2 answer projection liveness | `presented` 只记录 answer 相关或 claimed/cancel 命中消息；普通 >256 不再消耗预算。overflow 按 family 标记，只有没有其他证据的对应消息为 unknown，不再全局 `complete:false` 永久锁死。普通 >256 + queued discard 可重答；answer >256 的受影响 repair 仍安全拒绝 |
| minor 1 冷索引 fail-open | no-cache、>64 unknown cap、读取失败或语料未就绪时 prompt `DEVLEAD_SESSION_UNAVAILABLE`；stale-negative 必须 exact-fold，真实 foreign 返回 `DEVLEAD_FOREIGN_SUPERVISOR`。无持久语料 Host 保持 live-only 可用 |
| minor 2 cache 叙事 | 文档与证据改为真实 parent `devLead` stateVersion 5（mode/watch 2），Batch 1 为 7/3/3；真实 registry refold 覆盖 |
| minor 3 outbox / storage 文案 | 区分版本戳不接受时 absent 且文件保留、当前 schema 的 backup-and-skip；composed storage open/read 失败 fail closed，仅未组合 storageDomain 时进程内兜底 |
| minor 4 warning | legacy record 仍是每进程 latch；outbox open warning 改为每 service context 去重，连续两次 open 只 warn 一次 |
| minor 5 repairPending 矛盾 | DESIGN 改为 wire projection 与 tool 均可见，whole-value repair record 双向发布 |
| minor 6 文案漂移 | rollback 改为旧构建遇已知 v2 类型会 freeze 并需 reset；UI tooltip 加入 `provisional`；prompt `warning?` 补非 answer 幂等 process-local 说明 |
| minor 7 测试缺口 | replay 配额改为 3→replay→第 4 成功→第 5 拒绝；late query/persistence 触发真实第二次 rehydration；64 个 cold read 上限且 map 不增长；真实 `turnSourceHandle.stateOf` question wiring；真实 registry refold；损坏 repair record 冻结 |

## 二次修复：cold index 状态机与重试恢复

独立 delta 复核指出的晚绑定 fail-open 与不完整后永久 fail-closed 已关闭：

- query/persistence 出现后的每次重扫先清除旧的 live-only 授权，readiness/完整扫描结束前不得利用旧 `true` 放行；阻塞 read 的负控返回 `DEVLEAD_SESSION_UNAVAILABLE`。
- 只有完整扫描才 `finalizeRehydration()`；不完整时保留 `rehydrated=false`，在 `rehydrateFromPersistence.finally` 清理旧 hook 并重新调度 optional-service / 250ms 重试，避免 timer 已在扫描中触发后没有后续 retry。disposed 路径不再创建 effect。
- 首次 no-cache 不完整后，晚装 projectionCache 的第二次扫描成功，合法 prompt 恢复；首次扫描超过 250ms 且失败，在无新注入时也由 finally 重新调度并恢复。capped 断言改为每次扫描最多 65 次读取，允许合法重试。

最终冻结输出：

```text
pnpm verify
Test Files  34 passed (34)
Tests       1414 passed (1414)
build complete (6 targets)

pnpm check:packages
check-packages: OK (6 packages)

19:16:01 patch:      221/221  PATCH_EXIT=0
19:16:48 installed:  221/221  INSTALLED_EXIT=0
19:17:32 no-worktree: 198/198 NO_WORKTREE_EXIT=0
```

client revision：`5acdbd8d704e`；日志：`/tmp/dsh-devlead-batch1-final4-{patch,installed,no-worktree}.log`。

## 二次修复追加：cursor、退避与真实活性证据

本轮把冷扫描、重试与 answer 活性测试改成可复现的实际契约：

- 冷扫描以 `coldScan.records/index/leads/active/complete` 游标分批推进，每批最多 64 个 unknown/stale-negative；失败行保留在游标中等待重试，corrupt 行前进并标 degraded，最终完成才 finalize。70 个 benign/unknown 行和 no-cache 混合行都能恢复，不再把 cap 当作永久拒绝。
- optional-service hook 只注册一次；重试由单一 timer 驱动，250ms 起步指数退避、5s 封顶、12 次上限，warning 按原因去重。persistence 先到而 query 未到时保留 query listener。
- 只有扫描与应用都成功才 complete；live Agent/attach-only projection failure 显式 fail closed。
- service 活性测试真实经过 `queueAnswerDiscard → reconcileAnswerDiscards → survivalProof`，不再只覆盖 live discard。普通 >256 清除 repairPending 并可重答；answer >256 仅对应消息 unknown。`childAnswerUnknown` 对仍在 presented 中的 message 返回 false。
- `devLeadChildAnswers` stateVersion 2 有真实 registry refold；live observer 也只记录 answer/claimed presentation，普通聊天不再持续 evict/warn。

mutation 负控（均先改回旧行为、确认失败后恢复）：

| 类型 | 实际结果 |
| --- | --- |
| B1：finalize 永久 cap | `B1_MUTATION_EXIT=1` |
| retry：0ms 热循环 | `RETRY_MUTATION_EXIT=1` |
| M2：`childAnswerUnknown` 全局 true | `M2_SERVICE_MUTATION_EXIT=1` |
| 应用阶段错误仍 finalize | `APPLY_MUTATION_EXIT=1` |
| live projection failure 被跳过 | `LIVE_FAILURE_MUTATION_EXIT=1` |

旧 M2 mutation 日志只证明 fold 级用例失败，不再被引用为 service 覆盖；当前 service 负控直接 spy `survivalProof` 并验证调用。

## 二次修复最终门禁

```text
pnpm verify
Test Files  34 passed (34)
Tests       1420 passed (1420)
build complete (6 targets)

pnpm check:packages
check-packages: OK (6 packages)

20:09:19 patch:      221/221  PATCH_EXIT=0
20:09:53 installed:  221/221  INSTALLED_EXIT=0
20:10:27 no-worktree: 198/198 NO_WORKTREE_EXIT=0
```

client revision：`43cae907514d`；日志：`/tmp/dsh-devlead-batch1-final5-{patch,installed,no-worktree}.log`。

## 二次修复最终复核门禁（最终树）

```text
pnpm verify
Test Files  34 passed (34)
Tests       1424 passed (1424)
build complete (6 targets)

pnpm check:packages
check-packages: OK (6 packages)

20:35:51 patch:      221/221  PATCH_EXIT=0
20:36:00 installed:  221/221  INSTALLED_EXIT=0
20:36:09 no-worktree: 198/198 NO_WORKTREE_EXIT=0
```

client revision：`2ce2a5a4eedb`；日志：`/tmp/dsh-devlead-batch1-final9-{patch,installed,no-worktree}.log`。

## 三次修复：cold-index fail-open 与终态恢复（从 Kimi 429 的未提交 WIP 续做）

本轮以 delta 复核对 `6ef5631` 的 findings 为输入（1 blocker + 4 major + minors），从 Kimi 实施到一半的未提交
WIP 继续完成，**没有 revert**：继承的 WIP 为 `packages/devlead/src/index.ts`（+112/−26，含
`rehydrationEpoch`、`DEGRADED_REHYDRATION_PROBE_MS=30s`、`state.trusted`、`liveAttachFailure` 部分收口、
7 个新测试草稿）与 `packages/devlead/tests/phase2.spec.ts`（+192，末个测试缺右括号、无法解析）。起点工作树
dirty、`main` ahead 3（HEAD `6ef5631`）。本轮在该 WIP 上继续实现、修复半成品并重写负控，未回退任何已有修复。

### 修复清单（逐项落实）

| 项 | 实现 |
| --- | --- |
| B1（blocker） | `coldScan.trusted`：只有 corpus 就绪后取得的 listing 才允许 finalize；`complete` 必须同时满足 `trusted`；未就绪时取得的 listing 在下次就绪后整份丢弃并重新 list；负控覆盖 corpusReady false→true 且含合法 foreign supervisor 的恢复路径（恢复后 prompt 只能 `DEVLEAD_FOREIGN_SUPERVISOR`，绝不 delivered=true） |
| M1（major） | lifecycle wake（`agent/created`、`session/event`）不再清除 corrupt/live-failure 终态、不再重置 attempts/delay；queryReady 翻转时重建 lifecycle listener；corrupt/cap 终态保持到显式 `/devlead reset` 或服务重新组合（新注入的 persistence/cache/query 触发新 epoch） |
| M2（major） | live projection failure 写入 `state.complete=false` + `state.liveFailure=true`，阻止 cursor 被清除；与 at-rest corrupt 区分开；终态走单条 30s 慢速探针，不在 250ms 快速重试里反复全量重扫；探针在修复后重新 list+scan 并恢复授权 |
| M3（major） | optional-service hook 内**同步**把 `supervisionIndexComplete=false`，再调度扫描；负控证明 250ms 窗口内 prompt 立即 `DEVLEAD_SESSION_UNAVAILABLE` 且 `readSessionCalls===0`，不允许绕过 cold supervisor 证明 |
| M4（major） | corrupt/live-failure/12 次退避耗尽后进入单条 30s 慢速降级探针（无热循环），`/devlead reset` 立即恢复；错误文案带原因+恢复动作（`/devlead reset`、删除/修复坏 Session、等待探针）；read 失败区分 not-found 与瞬时错误：not-found 在同一次尝试内重新 list 一次，且不消耗重试预算，瞬时错误保留 cursor 由有界退避重试；README/COMPATIBILITY/DESIGN/OPTIONAL-DEPENDENCIES 改写为多批游标语义并写恢复路径 |
| minor 1 | persisted-scan applied 失败负控：spy `DevLeadNotificationHub.rehydrate`，只在第 2 次（persisted scan 应用）抛错，断言失败确实发生在 persisted 分支（payload 为 `['cold-lead']`）且不投递 |
| minor 2 | answers.spec 新增 observer answer-only 负控：300 条普通 `kind:'user'` 消息不进入 presented、不驱逐 answer 证据、不消耗 256 预算，overflow warning 对非 answer family 至多一次；并走真实 cold-read projection 复核 |
| minor 3 | 版本叙事改为真实历史 5→7（`stateVersion: 6` 从未提交：`git log --all -G "stateVersion: 6"` 为空）；`fold.ts` 注释 `<=6`→`<7`；phase2 真实 registry refold 用 ver 5；DESIGN.md 对应段落同步 |
| minor 4 | service.spec 的 6 处真实 `setTimeout(300)` 改为等待真实完成状态/告警的条件轮询；`readSessionCalls % 65 === 0` 改为真实上界（`>=65` 且 `<=65*(1+12)`） |
| minor 5 | reset 与 in-flight scan 竞态：`rehydrationEpoch` 覆盖 scan 应用前、后与 finally；reset 后旧 run 不得 finalize/re-arm，settle 后从新 epoch 重新扫描；负控用闸门卡住旧 run 的 read，断言 reset 后、post-reset scan 完成前 prompt 必须 fail closed |
| minor 6 | not-found 不再把 cursor 钉在坏行：同一次尝试重列一次并在重列后的 listing 上继续 exact fold；断言 `listSessionsCalls===3`、读取序列 `deleted(deleted 抛错) → deleted → stable`，boot 内即完成、无额外重试周期 |
| minor 7 | cap 时不再把 live-only 早退计成失败（`rehydrationScanned`）；`disposeRehydrationRetry` 的 delay 归 250 而非 0；reset 清 timer/warnings/coldScan/recoveredActive/fresh 标志并复位 degraded reason；终态不再保留误导性 recoveredActive |

### 真实时间线

| 时间 | 事实 |
| --- | --- |
| 20:58 | 接管 WIP，修复 `phase2.spec.ts` 未完成括号；定向 `npx vitest run packages/devlead/tests/phase2.spec.ts` 为 **34 passed / 5 failed**（probe 用例 fake timer 泄漏级联，另有 applied/not-found 与两条 answer 投影用例超时） |
| 21:05–21:10 | 补齐 B1/M1/M2/M3/M4 与 minors，重写 phase2 负控；phase2 达到 **41/41** |
| 21:12:29 | 全量 `pnpm verify`：**34 files / 1434 tests** 全过，build 6 targets |
| 21:13:56–21:14:01 | 7 项 mutation 在最终树逐一重跑，全部 `EXIT=1`；每次恢复源码后 `diff -q` 确认与最终树一致 |
| 21:14:07–21:14:23 | 最终 `pnpm verify` + `pnpm check:packages`：34/1434、`OK (6 packages)`；`git diff --check` EXIT=0 |
| 21:14:27–21:14:53 | 最终 patch e2e：**221/221，PATCH_EXIT=0** |
| 21:14:53–21:15:18 | 最终 installed e2e：**221/221，INSTALLED_EXIT=0** |
| 21:15:18–21:15:43 | 最终 no-worktree e2e：**198/198，NO_WORKTREE_EXIT=0** |

最终 e2e 的 client revision 为 `fe2e2ce73e39`（patch/installed 日志 boot graph 行）。

### 门禁真实输出（最终树）

```text
$ pnpm verify
Test Files  34 passed (34)
Tests       1434 passed (1434)
build complete (6 targets)
VERIFY_EXIT=0

$ pnpm check:packages
check-packages: OK (6 packages)
CHECK_PACKAGES_EXIT=0

$ pnpm e2e --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27; phase 1b: 12/12; phase 2: 23/23; phase 3: 128/128; phase 1e: 31/31
  total: 221/221 checks
PATCH_EXIT=0

$ pnpm e2e --flow installed --no-build
E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
  total: 221/221 checks
INSTALLED_EXIT=0

$ pnpm e2e --no-worktree --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  total: 198/198 checks; phase 2 skipped (--no-worktree)
NO_WORKTREE_EXIT=0
```

日志（本机）：`/tmp/dsh-batch1-r3-final/{verify,e2e-patch,e2e-installed,e2e-no-worktree}.log`。

### Mutation 负控（最终树；先写回旧行为/去掉修复，确认目标测试失败后恢复）

| 场景 | mutation | 目标测试 | 结果 |
| --- | --- | --- | --- |
| B1-new | 恢复旧 `complete`/去掉 trusted re-list | `re-lists after corpus readiness instead of trusting a pre-ready partial snapshot` | `EXIT=1`，`expected DEVLEAD_FOREIGN_SUPERVISOR, but the call succeeded`（fail-open 被抓住） |
| M1 | lifecycle wake 清 corrupt 并重置预算（pre-fix） | `keeps terminal corruption across lifecycle events without resetting the retry budget` | `EXIT=1`，coldScan 身份断言失败（终态被清） |
| M2 | 去掉 liveAttachFailure 的 state 写入 | `keeps a live projection failure terminal, skips hot rescans, and recovers via the slow probe` | `EXIT=1`，coldScan.liveFailure 断言失败（cursor 被清） |
| M3 | 把授权失效推迟到 setTimeout(0) | `rejects immediately when corpus services arrive before the retry timer runs` | `EXIT=1`，`expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded` |
| M4 | 去掉 30s degraded probe（只 warning） | `recovers after the bounded retry budget through the slow degraded probe` | `EXIT=1`，探针 timer 未定义 |
| applied/persisted | catch 里忽略 apply 失败并标记成功 | `rejects when the persisted scan application fails after a complete scan` | `EXIT=1`，`expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded` |
| reset epoch | 去掉 scan 应用前后两处 epoch guard | `ignores an in-flight pre-reset scan and rescans after it settles` | `EXIT=1`，reset 后旧 run 仍 finalize，prompt 未被拒绝 |

每项 mutation 的完整日志：`/tmp/dsh-batch1-r3-mut/{B1,M1,M2,M3,M4,APPLIED,EPOCH}.log`
（文件内记录 `EXIT` 与耗时；本轮所有 mutation 均在该轮最终树上重跑，未沿用早于最终树的日志）。

### 证据修正

- 删除原时间线第 20 行未经授权、不可核实的结论性表述，该行只保留当时真实的 verify/check 结果。
- 本轮不引用任何早于最终树的 mutation 或 e2e 日志；结论只引用可复现的命令输出与日志路径。

### 残余风险（非未完成项）

- not-found 判定基于错误文本启发式（`not found|does not exist|unknown session|SESSION_NOT_FOUND`）；后端文案变化可能把瞬时错误当成“会话消失”。影响有界：同一次尝试最多重列一次、不消耗预算，最坏多一次 list，不会 fail-open。
- 慢速探针周期为 30s：修复 corrupt Session 后，prompt 授权最坏约 30s 才恢复；`/devlead reset` 立即恢复，删除 Session 也要等一次探针。
- live projection failure 依赖 Host 重折该 Session 的 projection；坏记录仍在日志时探针会持续失败，这是既定恢复路径（reset/删除/修复日志）。
- persisted-scan 应用失败负控用 spy `DevLeadNotificationHub.rehydrate` 注入，未在真实 e2e Host 上制造该失败；真实 Host 的冷重建成功路径由 installed/patch phase 1b 覆盖。
- 冷索引的 listing 在 not-found/服务重组之外不会重取；finalize 之后由其他 Host 进程写入的 cold lead Session 不会被本进程发现，需重启/服务重组（与既有设计一致）。
- mutation 与 e2e 日志保存在本机 `/tmp`，不随仓库提交。
