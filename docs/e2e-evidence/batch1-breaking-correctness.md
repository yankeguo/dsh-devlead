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

- not-found 分类以稳定 remote code `SESSION_QUERY_SESSION_NOT_FOUND` 为主，文本正则仅作 fallback；fallback 仍可能把瞬时文案误判为“会话消失”，影响有界：同一 attempt 最多 re-list 一次，re-list 后仍在列/再次 not-found 计 read 失败并进入有界预算，不会 fail-open。
- 慢速探针周期为 30s；探针本身不修复原因：corrupt at-rest replay / live projection failure 需要先打开（resume）受影响 Session 再 `/devlead reset`（reset 需要 live Agent），或修复/删除损坏日志，原因移除后下一次探针或重启 Host 才会恢复。
- live projection failure 依赖 Host 重折该 Session 的 projection；坏记录仍在日志时探针会持续失败，这是既定恢复路径（reset/删除/修复日志）。
- persisted-scan 应用失败负控用 spy `DevLeadNotificationHub.rehydrate` 注入，未在真实 e2e Host 上制造该失败；真实 Host 的冷重建成功路径由 installed/patch phase 1b 覆盖。
- 冷索引在 finalize 后不会主动重取；服务组合变化只在一次 attempt 或下一次 prompt 的服务身份复核时惰性发现；finalize 之后由其他 Host 进程写入的 cold lead Session 不会被本进程发现，需要重启 Host（或 reset 后重扫）。服务重组本身不会重建已 finalize 的索引。
- mutation 与 e2e 日志保存在本机 `/tmp`，不随仓库提交。


## 四次修复：residual major（P5 / P6 / P8）+ minors（对 `2655ddf` 的第四轮 delta）

输入：第 4 轮 delta 复核对 `2655ddf` 的 FINAL ISSUES——3 个 residual major（P5 trusted 语料未绑定
barrier 校验结果、P6 not-found 每轮重置失败预算、P8 扫描无 signal/deadline）与 8 个 minor。
本轮从 clean tree（HEAD `2655ddf`，origin/main 仍 `a21c7b7`）修复，**未 push、未 bump version、
未打 tag**。冻结代码 commit：`d12d9bb4...`；门禁与 mutation 均在该 commit 的干净树上跑，之后
仅以未推送的 `git commit --amend` 追加本证据文件（最终 HEAD 的代码树与 `d12d9bb` 相同）。

### 逐项修复

| 项 | 实现 |
| --- | --- |
| P5 | barrier 现在返回它用 persistence 真值校验过的 `ReadyCorpusListing`，权威扫描直接消费该 listing，不再二次 list 未校验语料；扫描自己的 not-found re-list 与 finalize 复核同样经 `verifyCorpusListingNow` 校验（persistence ids ⊆ listed ids）；finalize 要求快照 rows 仍全部在列（消失即 fail closed 并重扫），扫描期间新增的 persisted row 在最多 2 次有界 refresh 内追加扫描；已证明的授权绑定到稳定的服务 provision 身份（reflect `uid` + 值 token；`Symbol.for('cordis.original')` 解包 traceable proxy），prompt gate 发现原地替换/卸载时同步作废授权并触发重扫；`ctx.inject` 观察 arrival/replacement/unload，有意销毁 hook 不会误判成卸载；一次证明过持久语料的 Host 不退回 live-only 授权。负控：barrier listing 变化、re-list 省略 foreign supervisor、原地替换、移除绑定。 |
| P6 | `not-found` 先按 `remoteCodeOf === 'SESSION_QUERY_SESSION_NOT_FOUND'` 分类（文本正则仅 fallback）；re-list 后该 id 仍在列则第二次 not-found 计 read 失败，只有 id 真消失或游标前进才宽恕预算；not-found re-list 时把 corrupt/liveFailure 终态带入新 state；read 失败与 cap warning 分开；retry cap 在“游标保留”的场景下变 sticky（probe 失败只重排 probe）。**覆盖范围修正（第五轮）**：此处的负控用单行 corpus + 第一批内 not-found，只证明“同一 attempt 内重复 not-found 计预算并 arm probe”，**没有**覆盖 ghost 位于第一批 64 读之外、re-list 仍列出该行时 cursor 被重置回 0 的场景；当时的 cursor/progress 语义在该场景下仍会 fast/probe 循环（见第五轮 R2）。 |
| P8 | 整次 attempt（barrier + listing + 每次 `persistence.list` / `listSessions` / `readSession`）受 `REHYDRATION_ATTEMPT_TIMEOUT_MS=5s` 的 AbortSignal 约束，后端 promise 忽略 signal 也会被 race 放弃；超时 bump epoch、按失败计入预算，由下一次有界 attempt/慢速探针接管，`[Service.init]` 不再可能被挂起后端卡死。负控：`readSession` 永不 settle 时 boot 在 5s deadline 后完成并可在后续 attempt 恢复。 |
| minor 1 | cap 检查先于 armed-timer 早退（cap 当刻在跑的 attempt 自己 arm 的 fast timer 会被原地升级为 probe）；probe 回调不再重置 attempts。**覆盖范围修正（第五轮）**：当时“只有 progress/complete/reset/recomposition 清除 cap”的说法过强——`rehydrateFromPersistence` 的 finally 仍会在 `nextIndex > previousIndex` 时清除 capped，而 retry-cap probe 会先把游标重置为 0，因此失败点在第一批 64 读之后时，probe 扫描“新进度”（0→64）会清掉 capped 并重启 12 次快速退避，fast/probe cycle 并未真正终止（见第五轮 R1）。 |
| minor 2 | 服务身份每次变化都 bump epoch：注入 callback 每次 replacement/unload 都作废授权（不再只在 `fresh` 时）；attempt 入口的 binding snapshot 检测原地 `ctx.set`；prompt gate 再做一次身份复核。**覆盖范围修正（第五轮）**：该轮“原地替换/移除服务作废授权”的负控用 `ctx.provide` 的普通对象 fake 实现；生产路径上真实 `extends Service` 的实例在 `_getImpl(name).value` 里自带 `Symbol.for('cordis.tracker')` 但没有 `Symbol.for('cordis.original')`，token 退化为 `undefined`，同 uid 的原地替换因此检测不到（M3 fail-open，见第五轮 R3）。 |
| minor 3 | 恢复文案改为真实路径：`/devlead reset` 需要 live Agent，冷 Session 必须先 open/resume 后 reset；探针不修复原因，只在原因移除后恢复；README/COMPATIBILITY/DESIGN/错误文案同步。 |
| minor 4 | COMPATIBILITY/DESIGN 中 barrier 超时的“warning + best-effort 继续”改为“本 attempt 不扫描该 listing、prompt 保持 fail-closed，直到就绪后的完整扫描”。 |
| minor 5 | 证据残余风险改为 finalize 后只能重启 Host（或 reset 后重扫），服务重组不会重建已 finalize 的索引；retry-cap 文案同步 sticky 语义。 |
| minor 6 | live-failure / retry-cap 测试改走生产路径（fake-timer boot → 扫描结束自动 arm probe → 第二次失败仍只有一条 probe）；补错文案断言（`Open (resume)`、`/devlead reset there`）。 |
| minor 7 | `isSessionNotFoundError` 注释归位并按 `remoteCodeOf` 优先；read 失败不再落入 cap warning；删除 dead 的 `persistedLeadRecords(scanPersisted:false)` 路径；`ctx.inject` 对每个服务区分 registration/arrival/replacement，并保留 present 服务观察以捕获卸载。 |
| minor 8 | mutation 日志内嵌 `FROZEN_COMMIT`、mutation git diff 片段、恢复命令与 `git status --porcelain` 空 + `git diff --quiet` 退出码；全部 mutation 在冻结树上重跑。 |

新增/重写测试（`packages/devlead/tests/phase2.spec.ts`，41 → 48 例）：barrier listing 变化拒绝、
scan re-list 省略 foreign supervisor 拒绝、重复 not-found 预算、挂起后端 attempt deadline、
原地替换/移除服务作废授权、read-vs-cap warning、生产路径 live-failure 与 sticky retry-cap
（替代旧的手动清 timer 用例）；全仓 **34 files / 1441 tests**（+7）。

### 真实时间线

| 时间 | 事实 |
| --- | --- |
| 21:27 | 起点复核：HEAD `2655ddf`、origin/main `a21c7b7`、工作区干净；开始读码与修复 |
| 21:28–21:43 | 实现 P5/P6/P8 + minors，重写负控；phase2 **48/48**；devlead 全包 **878/878**；tsc 通过 |
| 21:44:33 | 首轮 `pnpm verify`：34 files / **1441 tests** 全过，build 6 targets（`VERIFY_EXIT=0`） |
| 21:45–21:47 | 首轮三条 e2e 暴露真实 Host 问题：`ctx.get` 对 cordis service 每次返回新的 traceable proxy，旧的对象身份比较把三个服务都判成“重组” → 改为 provision `uid` + 值 token（`Symbol.for('cordis.original')` 解包），并允许 finalize 复核在快照后新增 persisted row 时有界刷新/追加扫描，避免高频创建 Session 的 Host 永久 fail-closed |
| 21:47–21:51 | 修复后 e2e patch 恢复 **221/221**；重跑单测与 tsc 通过 |
| 21:52:27 | 候选树（commit 前）`pnpm verify` 34/1441 全过、`check:packages` **OK (6 packages)** |
| 21:52:53–21:53:43 | 候选树三条 e2e：patch **221/221**、installed **221/221**、no-worktree **198/198** |
| 21:54:39 | 本地 commit `d12d9bb`（未 push、未 bump version、未打 tag；README/README.zh/docs 同步） |
| 21:54:48 | 10 项 mutation 在冻结树逐一重跑：全部 `MUTATION_TEST_EXIT=1`，每项 `restore_clean=true` |
| 21:55:30–21:56:46 | mutation 恢复后冻结树最终门禁：verify 34/1441、check OK、patch 221/221、installed 221/221、no-worktree 198/198；client revision `4ab1808bd84d` |

### 门禁真实输出（mutation 恢复后的冻结树）

```text
$ pnpm verify
Test Files  34 passed (34)
Tests       1441 passed (1441)
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

日志（本机）：`/tmp/dsh-batch1-r4/final-{verify,check-packages,e2e-patch,e2e-installed,e2e-no-worktree}.log`。

### Mutation 负控（冻结树 `d12d9bb`，全部重跑；全部 `EXIT=1`）

| 场景 | mutation | 目标测试 | 实际失败输出 |
| --- | --- | --- | --- |
| P5 | 忽略 barrier 校验过的 listing + 去掉 re-list persistence 复核 + 去掉 finalize 复核 | `refuses delivery when the listing authorized by the barrier changes before finalize` | `expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded`（fail-open 被抓住） |
| P6 | 恢复“not-found 每轮都算 progress”的旧行为 | `counts a repeated not-found as a read failure instead of forgiving the budget every round` | `expected 0 to be greater than or equal to 1`（预算被每轮重置） |
| P8 | attempt deadline 5s → 1h | `abandons a scan attempt whose backend never settles and recovers on a later attempt` | `bootService did not settle within 60s of advanced fake time` |
| retry-cap sticky | 去掉 capped 早退 + probe 失败重置 attempts/delay | `keeps the retry-cap probe sticky instead of restarting the fast backoff` | `expected false to be true`（cap 标志/单 probe 断言失败） |
| M3 replace | 去掉 prompt gate 的服务身份复核 | `invalidates the proven index when a corpus service is replaced in place` | `expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded` |
| M1 | lifecycle wake 清 corrupt 终态并重置预算（pre-fix） | `keeps terminal corruption across lifecycle events without resetting the retry budget` | `expected undefined to be { records: …, … }`（coldScan 被清） |
| M2 | 去掉 `coldScan.liveFailure` 写入 | `keeps a live projection failure terminal and recovers via the production slow probe` | `expected false to be true`（liveFailure 未保留） |
| M4 | 去掉 30s degraded probe（只 warning） | `keeps a live projection failure terminal and recovers via the production slow probe` | `expected false to be true`（probe 未 arm） |
| applied | catch 里忽略 apply 失败并标记成功 | `rejects when the persisted scan application fails after a complete scan` | `expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded` |
| epoch | 去掉 scan 应用前后两处 epoch guard | `ignores an in-flight pre-reset scan and rescans after it settles` | `expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded` |

每次 mutation 的完整日志（含 `FROZEN_COMMIT`、mutation git diff 片段、测试输出与
`MUTATION_TEST_EXIT`、`git checkout --` 恢复后的 `git status --porcelain` 空与
`git diff --quiet EXIT=0`）：`/tmp/dsh-batch1-r4/mut/<name>.log`，汇总
`/tmp/dsh-batch1-r4/mut/SUMMARY.json`（10/10 `restore_clean=true`）。

### 证据修正（本轮）

- COMPATIBILITY/DESIGN 不再声称 barrier 超时会 warning + best-effort 继续扫描；实际行为是
  fail-closed，直到后续 attempt/探针取得完整校验 listing。
- 恢复指引不再暗示 `/devlead reset` 对冷 Session 直接可用：reset 需要 live Agent，冷 Session
  必须 open/resume 后 reset；慢速探针只在原因移除后恢复。
- 本条前的残余风险已同步：finalize 之后的冷索引只能靠重启 Host（或 reset 后重扫）重建，
  服务重组不会重建已 finalize 的索引；retry-cap 为 sticky。

### 残余风险（本轮，非未完成项）

- attempt deadline 为 5s：极慢但可用的后端可能在单次 attempt 内被截断；游标前进会清零预算，
  下一次 attempt 继续，真正挂起的后端在 12 次预算后由单条 30s probe 兜底（fail closed 优先）。
- finalize 复核允许“扫描期间新出现的 persisted row”并在最多 2 次 refresh 内追加扫描；持续高速
  创建 Session 时，最后一次 refresh 之后的行留给后续 rescan/重启（与 finalize 后其他进程写入
  的既有边界一致）。
- 服务身份比较用 cordis provision `uid` + 值 token（traceable proxy 通过
  `Symbol.for('cordis.original')` 解包）；若某个实现在无法解包且不做 reprovide 的情况下原地
  `ctx.set` 替换，检测退化为 uid（正常重挂载会换 uid）。finalize 后不再监听组合事件，替换在
  下一次 prompt 的 gate 处惰性发现（发现时 fail closed + 重扫）。
- not-found 文本 fallback 仍可能误判瞬时错误；影响有界（同 attempt 一次 re-list、重复即按 read
  失败计入预算）。at-rest corrupt / live projection failure 的修复仍依赖 Host 重折或人类修日志。
- 就绪校验假设 `sessionPersistence.list()` 返回完整的 stored id 集合（与 COMPATIBILITY 中已文档化
  的假定一致）：若该服务在持久语料实际存在时短暂返回空列表，barrier 会按“全新 Host”通过并以
  当次 listing 授权；这是 persistence 契约假设，不是 DevLead 能独立证明的部分。
- mutation / e2e 日志保存在本机 `/tmp`，不随仓库提交。

## 五次修复：retry-cap 跨批粘滞 / 64 读窗口外 ghost cursor / 真实 cordis Service 绑定（对 `d98c5ea` 的第五轮 delta）

输入：第五轮 delta 复核对 `d98c5ea` 的 FINAL ISSUES——3 个可复现 major（R1 retry-cap 在失败点位于
首批 64 读之后时 sticky 失效；R2 ghost 在 64 读窗口之外时 cursor 被 not-found re-list 重置；R3
binding token 对真实 cordis Service 恒 `undefined`）与 7 项 medium/minor。本轮从 clean tree
（HEAD `d98c5ea`，origin/main 仍 `a21c7b7`）修复，**未 push、未 bump version、未打 tag**。冻结
代码 commit：`d282f62`（先提交 `e3e8424`，随后仅对新增测试做一次断言写法修正——用布尔对象
身份比较替代会触发 cordis tracker 代理打印错误的 `toBe(Service 实例)`——amend 为 `d282f62`；
门禁与 mutation 均在该 commit 的干净树上重跑）。之后仅以未推送的 `git commit --amend` 追加本
证据文件（最终 HEAD 的代码树与 `d282f62` 相同）。

### 逐项修复

| 项 | 实现 |
| --- | --- |
| R1（major） | 新增 `rehydrationScanHighWater`：扫描结束把“本次 attempt 结束时游标”记为高水位，只有下一次 attempt 的游标**严格越过**该点才算 progress；仅重读同一批前缀（0→64）不算。`rehydrateFromPersistence` 的 finally 不再因 progress 清除 sticky cap（`rehydrationRetryCapped` 只由完整扫描成功 finalize、reset、语料重组合清除），probe 的批次推进也不清。retry-cap 探针**保留 coldScan 游标**（corrupt/live-failure 探针才丢弃终止态快照），失败点位于第一读批之后时探针从失败点重试，而不是每 30s 重读前 64 行；probe 再次失败继续 arm 30s probe，不再 restart 12 次 fast backoff。新增失败点在第 65 行（>64 行 corpus）的生产路径负控：cap 后 30s probe 只重读失败行（成功读取数不增长）、capped 保持、10s 内无 fast timer；原因移除后下一次 probe 从保留游标完成并 finalize。 |
| R2（major） | not-found re-list 后**不再无条件 `coldScan = undefined` 重置 cursor**：`verifyCorpusListingNow` 先用 persistence 真值复核新 listing；若该 id **仍在列**，则不是“会话消失”而是这一行的读取失败——保留快照/游标，对该行在同一 attempt 内**重试一次**（一次性 transient not-found 可在本 attempt 恢复）；同一 attempt 内再次 not-found 进入顶部失败分支，`readFailed` 计预算、游标不动，12 次后进入 sticky cap + 30s probe。只有该 id 真的从新校验 listing 消失时才丢弃陈旧快照、从新 listing 重扫（此时才宽恕预算）。新增 100 行 corpus、第 90 行恒 not-found 的负控：不重置 cursor（cursor 稳定在 89，而非 64）、cap 后 3s 窗口内无 list/read、complete=false；原因移除后 probe 从 ghost 行继续完成。 |
| R3（major，生产路径 fail-open） | `corpusBinding` 的 token 改为 **`ctx.reflect._getImpl(name).value` 的对象身份**；只有当该 provision 值本身是 traceable proxy（同时带 `Symbol.for('cordis.tracker')` 与 `Symbol.for('cordis.original')`）时才解包 `original`。真实 `extends Service` 的实例自带 tracker symbol 但没有 `original`（后者只是读代理 getter），旧实现返回 `token: undefined`，同 uid 的原地 `ctx.set` 替换被 `bindingEqual` 判为未变化。`impl.value === undefined` 现在返回 `undefined` binding（移除），`ctx.set(name, undefined)` 因此作废授权；`bindingEqual` 对 undefined 保持 `left === right`。新增真实 cordis Service 负控：真实实例 token 必须等于该实例（不再 undefined）、原地替换后 prompt 立即 `DEVLEAD_SESSION_UNAVAILABLE` 并最终以新语料重证出 `DEVLEAD_FOREIGN_SUPERVISOR`、`ctx.set(undefined)` 移除后持续 fail-closed（恢复同实例 + lifecycle wake 后可重新证明）。**证据边界（第六轮修正）**：patch/installed e2e 使用真实 Host 的 `SessionQueryEngine` 等 Service，但 e2e 不观测 corpus binding/token、也没有制造替换事件，所以它只能证明真实 Host 上冷重建与 prompt 行为**无功能回归**，不能作为“生产路径无 false recomposition”的证明；该结论由生产形状测试（真实 `extends Service` fake + 原地 `ctx.set`）与第 4.1.1 节的代码路径支撑。 |
| medium/minor 1 abort vs change | 新 `CorpusVerification` 判别联合（`ok`/`aborted`/`unverifiable`/`changed`），abort 与“读到但不一致”分离：finalize 复核 abort 时保留 trusted 快照/游标、按失败计费（`rehydrationValidationTimedOut`），不再 `trusted=false` + 丢弃 cursor；not-found re-list 的 abort 同样保留快照/游标。finalize 复核有独立预算（`REHYDRATION_FINALIZE_TIMEOUT_MS=5s`）并在其前停掉 attempt deadline（`attempt.stop()`），慢而可用的 listing 之后从保留游标只重做复核；若复核追加了新行（`attempt.extend()` 重新 arm 有界窗口）后继续扫描。负控：listing 第 2 次起耗时 6s（>独立预算）时，首次 attempt 保留完整快照/cursor（index=5）并按失败计费，修复 listing 后下一次 attempt 不再读任何日志即 finalize。 |
| medium/minor 2 finalize refresh 预算 | 刷新预算耗尽而仍存在“未被扫描的新 persisted id”时**不 finalize**：保留游标、标记 `rehydrationFinalizeBlocked` 并计入失败（避免热循环），下一次有界 attempt 先 append+扫描新行再复核。新增负控：每次 finalize 复核都多出一行时，首轮 boot 与后续重试都保持 `rehydrated=false`/fail-closed；停止增长后才 append+扫描并 finalize。 |
| medium/minor 3 probe 文案 | 三处（`REHYDRATION_PROBE_MESSAGES`、`scheduleRehydrationProbe` JSDoc、prompt-gate 错误文案）改为“探针每 30s 重试一次，原因移除后恢复（recovers once the cause is removed）”，不再暗示探针只在原因移除后才开始 retry。README/README.zh/COMPATIBILITY/DESIGN 同步。 |
| medium/minor 4 dead 字段与文档 | 删除 `ReadyCorpusListing.expectedIds/at/seq`、`DevLeadColdScan.listedAt/listingSeq` 与 `rehydrationListingSeq`（全部 dead）；DESIGN §4.1.1 的 cursor 结构、AUDIT D2 的 dead 签名 `persistedLeadRecords(scanPersisted)`、“完全一致/超时 warning + best-effort”表述改为 superset + 有界刷新 + fail-closed 语义。 |
| medium/minor 5 abandoned promise / signal / dispose | `awaitScan` 注释收窄为“放弃的 promise 不被后续 attempt 复用，后续重试发起新 read”（不再声称 single-flight：复用永不 settle 的 promise 会让所有后续 retry 一起挂死）；readiness 屏障的 `listSessions` 通过 `listPersistedSessionsWithin(deadline, signal)` 接入 attempt signal；新增 `rehydrationAttempts` 跟踪在飞 attempt 的 controller，plugin dispose 时 `abortRehydrationAttempts()` 立即 abort 所有后端等待。负控：挂起 read 的 attempt 在 dispose 后 signal 全部 aborted 且 attempt 立即 settle。 |
| medium/minor 6 not-found 分类 | `isSessionNotFoundError` 只在**完全没有 code** 时才回落到 message 正则；有 code 时仅 `SESSION_QUERY_SESSION_NOT_FOUND` 返回 true（其他 code 即使 message 含 “not found” 也是读取失败）。负控：`code:'ETIMEDOUT'` + “temporarily not found” 文案只产生 1 次 barrier listing（不触发 re-list），修复后正常 finalize；code-positive 由 R2 的 `SESSION_QUERY_SESSION_NOT_FOUND` 负控覆盖。 |
| medium/minor 7 覆盖缺口 | 新增 12 个 phase2 用例：R1 与 R2 的 >64 读场景；真实 cordis Service 绑定/原地替换/`ctx.set(undefined)` 移除；mid-scan query Service 替换不 finalize；慢 listing 的 finalize 预算 + cursor 保留；refresh 预算耗尽不 finalize；770 行走 attempt/5s deadline；reset while hung；挂起 readiness barrier listing；coded transient 分类；dispose abort。 |

新增测试集中在 `packages/devlead/tests/phase2.spec.ts`（48 → **60** 例），全仓 **34 files / 1453
tests**（+12）；新增本地 helper `RealCorpusPersistence` / `RealCorpusQuery`（真实
`extends Service`，第二个实例用 shadow name 注册以作为合法 `ctx.set` 替换值）。

### 真实时间线

| 时间 | 事实 |
| --- | --- |
| 22:08 | 起点复核：HEAD `d98c5ea`、origin/main `a21c7b7`、工作区干净；读码并定位 R1/R2/R3 与 minors |
| 22:09–22:23 | 实现 R1/R2/R3 + minors；新增 12 个负控；`pnpm verify` 首轮 34/1453，phase2 **60/60** |
| 22:24–22:25 | 自查发现 finalize 复核停掉 attempt deadline 后 append 批次缺少 deadline，补 `attempt.extend()` 并重跑定向测试 |
| 22:25:40 | 本地 commit `e3e8424`（未 push、未 bump version、未打 tag） |
| 22:26:06–22:27:21 | 候选树三条 e2e：patch **221/221**、installed **221/221**、no-worktree **198/198** |
| 22:27:33–22:27:38 | 首轮 mutation 10 项：9 项按预期失败；BARRIER 1 项不可检出（见下），另 R3 因 vitest 打印 Service 实例报错而非断言失败 |
| 22:27–22:28 | 测试断言改为布尔对象身份比较（避免 tracker 代理打印错误），`git commit --amend` → 冻结 commit `d282f62`；移除不可检出的 BARRIER mutation 项 |
| 22:28:03–22:29:37 | 冻结树最终门禁：`pnpm verify` 34/1453（`VERIFY_EXIT=0`）、`check:packages` OK、patch **221/221**、installed **221/221**、no-worktree **198/198** |
| 22:29:39–22:29:44 | 9 项 mutation 在 `d282f62` 冻结树上重跑：全部 `MUTATION_TEST_EXIT=1`，全部 `restore_clean=true`（`git status --porcelain` 空 + `git diff --quiet` 退出 0） |
| 22:30 | 仅以 `git commit --amend` 追加本证据文件（最终 HEAD 的代码树与 `d282f62` 相同；未 push、未 bump version、未打 tag） |

### 门禁真实输出（冻结树 `d282f62`）

```text
$ pnpm verify
Test Files  34 passed (34)
Tests       1453 passed (1453)
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

client revision `2774836314bb`；日志（本机）：
`/tmp/dsh-batch1-r5/final2-{verify,check-packages,e2e-patch,e2e-installed,e2e-no-worktree}.log`
（更早的候选树日志在 `/tmp/dsh-batch1-r5/*-1.log` / `final-*`，不用于本证据）。

### Mutation 负控（冻结树 `d282f62`，全部重跑；全部 `EXIT=1` + `restore_clean=true`）

| 场景 | mutation | 目标测试 | 实际失败输出 |
| --- | --- | --- | --- |
| R1 sticky | 恢复旧 retry-cap probe 语义：probe 无条件重置 cursor，并在 finally progress 时清 `rehydrationRetryCapped` | `keeps the retry-cap sticky and the cursor when the failing row is beyond the first 64-read batch` | `expected false to be true`（cap 被清/cursor 被重置） |
| R1 high-water | 扫描结束把 high-water 归 0（退化为“任意 index 前进都算 progress”） | 同上 | `condition "retry-cap probe with a second-batch failure" did not settle within 200000ms of advanced time`（永不进入 cap） |
| R2 cursor | 恢复“not-found 一律丢弃快照并从 0 重扫” | `never resets the cursor for a ghost row beyond the first 64-read batch` | `condition "retry-cap probe with a second-batch ghost" did not settle within 200000ms`（cursor 抖动、cap 不可达） |
| R3 token | token 退回旧的 traceable-only 逻辑（真实 Service → `undefined`） | `binds the proof to the raw Service instance and detects an in-place replacement` | `expected false to be true`（token 不是实例 / 原地替换未检测） |
| abort-vs-change | finalize 复核 abort 当作语料变化（丢弃 trusted 快照与 cursor） | `retains the trusted cursor when the finalize validation times out instead of restarting the scan` | `expected undefined to be 5`（coldScan 被清） |
| refresh budget | 预算耗尽仍有新 persisted 行时照旧 finalize | `does not finalize while the finalize refresh budget is exhausted and new persisted rows keep appearing` | `expected true to be false`（首轮即 `rehydrated=true`） |
| dispose abort | dispose 不 abort 在飞 attempt | `aborts the in-flight attempt when the plugin is disposed` | `expected false to be true`（AbortController 未 abort） |
| not-found 分类 | 有 code 时仍回落 message 正则 | `classifies a coded transient read error as a read failure, not a vanished Session` | `expected 2 to be 1`（temporarily-not-found 触发多余 re-list） |
| validation 计费 | finalize validation 超时不按失败计费 | `retains the trusted cursor when the finalize validation times out instead of restarting the scan` | `expected 0 to be greater than or equal to 1`（attempts 未增长） |

每次 mutation 的完整日志（含 `FROZEN_COMMIT`、mutation diff、测试输出与
`MUTATION_TEST_EXIT`、恢复后 `git status --porcelain` 空与 `git diff --quiet` 退出 0）：
`/tmp/dsh-batch1-r5/mut/<name>.log`，汇总 `/tmp/dsh-batch1-r5/mut/SUMMARY.json`（9/9
`restore_clean=true`）。

另两项说明（不用不存在的日志充数）：

- **barrier listing 的 attempt-signal 接线**：曾尝试 mutation（去掉
  `listPersistedSessionsWithin` 的 signal 接线），但该 listing 自身有 readiness deadline（2s）
  小于 attempt deadline（5s），挂起 listing 仍会在 2s 内被自身 timer 解除，mutation 不可检出；
  接线作为 belt-and-braces 保留，负控 `abandons a hung readiness-barrier listing at the attempt
  deadline` 仍固定“挂起 listing 不会挂死 init”的行为。
- **被放弃 backend promise 的 single-flight**：问题按“收窄注释 + 不重用 promise”处理，不是
  新增 keyed single-flight（复用永不 settle 的 promise 会让所有后续 retry 一起挂死）；该契约的
  可执行证据是 R1/R2 负控（失败后下一次 attempt 重新发起 read 并继续推进）与 dispose abort
  mutation。

### 证据修正（本轮）

- 前文“四次修复”的 3 处覆盖范围表述已按真实测试范围改写（行内标注“**覆盖范围修正（第五轮）**”）：
  P6 的重复 not-found 负控只覆盖第一批内 ghost，未覆盖 64 读窗口外 cursor 重置（R2）；minor 1 的
  “只有 progress/complete/reset/recomposition 清除 cap”与实际代码不符（progress 仍会清 capped，
  R1）；minor 2 的“原地替换/移除服务作废授权”负控使用普通对象 fake，生产路径真实 `extends
  Service` 的 token 恒 undefined（R3）。
- 本轮不引用任何早于冻结树 `d282f62` 的 mutation/e2e 日志；上表只引用可复现命令与日志路径。

### 残余风险（本轮，非未完成项）

- finalize 复核使用独立 5s 预算并停掉 attempt deadline：极慢但可用的 listing 最多让一次 attempt
  计失败并保留快照/游标，下一次 attempt 只重做复核；持续的 listing 故障仍会 fail-closed（这是
  安全方向）。病理组合（慢 listing + 持续新增 Session）下首次有界 attempt 的最坏耗时会超过 5s
  （scan 5s + 至多 2 次 append 批次各自的 5s window + 每次复核 5s），但每一步都有独立上限，
  `[Service.init]` 不会被无限挂起。
- sticky cap 只在**完整扫描成功 finalize / reset / 语料重组合**时清除：retry-cap 探针保留游标
  并每 30s 推进一个 batch，若 corpus 很大（>64×n 行）且原因一直存在，恢复会按 30s/64 行推进，
  而不是恢复到快速退避；这是有意的有界恢复取舍。
- not-found 仍在列时的“行内重试一次”意味着每个 fast attempt 对永久 ghost 行最多 2 次 read +
  1 次校验 re-list；12 次后进入 30s probe，代价有界。若某后端把瞬时错误误报为稳定
  `SESSION_QUERY_SESSION_NOT_FOUND`，该行同样会按读取失败进入有界恢复，不会 fail-open。
- 真实 Service token 用 provision 值对象身份：不换 fiber、不换实例的 republish 不构成变化（正确）；
  若未来 cordis 把 `_getImpl().value` 改成返回读代理，则依赖 `original` 解包（仍有保底：uid 变化
  会被检测）。`ctx.set(name, undefined)` 依赖 `_getImpl` 仍返回该 provision（当前 cordis 行为，
  mock/未来版本变化由测试固定）。
- 载荷/日志行为不变：本轮只改 cold-supervision 状态机与文档；未 push、未 bump version、未打 tag。
- mutation / e2e 日志保存在本机 `/tmp`，不随仓库提交。

## 六次修复：unverifiable 计费/保留游标 + delivery-time proof（对 `7bf4b95` 的第六轮 delta）

输入：第六轮 delta 复核对 `7bf4b95` 的 FINAL ISSUES——唯一阻断 SAFE 的 major U1
（`CorpusVerification` 的 `unverifiable` 被当作 corpus changed / barrier 不计费，间歇 listing
失败时无界快速重扫）与 3 项 medium（gate→delivery TOCTOU、dispose 不能 abort finalize
validation、文档 5s 措辞）及 5 项 minor。本轮从 clean tree（HEAD `7bf4b95`，origin/main 仍
`a21c7b7`）修复，**未 push、未 bump version、未打 tag**。冻结工作树（提交前最终树，
`pnpm verify`/`check:packages`/三条 e2e 与全部 mutation 均在该树上运行）：

- `packages/devlead/src/index.ts` sha256 `104aa4d313a58a80a4235134589f93f1d1ef4eab0a24c77238e99295e6647506`
- `packages/devlead/tests/phase2.spec.ts` sha256 `8fe1a7038d928ad26b02a4ecd61d4d1a36b644dec4e668f08f1d23c2b7e66edd`
- 代码树与最终本地 commit 相同（本证据随该 commit 一起提交；未 push）。

### 修复前复现（与审查者数字一致；scratch spec 已删除、不随仓库提交）

在未修复的 `7bf4b95` 树上用临时 scratch spec（fake timer、100 行 corpus）复现：

| 场景 | 90s / 120s fake 后实测 |
| --- | --- |
| natural：`persistence.list` 每第 2 次抛错 | 90s：`attempts=0`、`capped=false`、`probe=false`、`cursor=highWater=64`、`reads=12,064`、`lists=241`、`persistence lists=481`（审查者：reads 764→12,064、lists 15→241） |
| staged：`verifyCorpusListingNow` 恒返回 unverifiable | 120s：`attempts` 在 0/1 间振荡、`capped=false`、`probe=false`、`reads=16,128`、`lists=322`（审查者：reads 16,128、lists 322） |

修复后同一负控（已作为正式测试提交）：

| 场景 | 实测 |
| --- | --- |
| natural（每 2 次 listing 失败） | 约 40s fake 内 `attempts≥12`、`capped=true`、`probe=true`、`cursor=highWater=100`、`reads=100`（每个 row 恰读一次）、list 调用有界；原因移除后下一次 30s probe 用保留游标 finalize，**新增读取 0** |
| staged（恒 unverifiable） | 约 40s fake 内 `attempts≥12`、`capped=true`、`probe=true`、`cursor=highWater=100`、`reads=164`（boot 空语料 64 读 + 重证 100 读）；原因移除后 0 新增读取 finalize |

### 逐项修复

| 项 | 实现 |
| --- | --- |
| U1（major） | `unverifiable` 与 `changed` 彻底分离，并和 abort 一样保留 trusted 状态、按失败计费：① finalize 复核 split 为 aborted（`rehydrationValidationTimedOut`）/unverifiable（新增 `rehydrationValidationUnverifiable`）/changed：aborted 与 unverifiable 都保留快照/游标/高水位并计一次失败，只有 `changed`（可读但 persistence 真值不被 listing 包含，或复核 listing 丢了快照行）丢弃并重扫；② not-found re-list 同样 split：aborted/ unverifiable 保留，`changed` 才丢弃；③ 就绪屏障返回 `{ listing, unverifiable }`，unverifiable（contains 不一致或 persistence 读不出到 2s 界限）由 `runRehydrationAttempt` 记入 charge 标志，同一 attempt 内后续成功的扫描入口复核会清除它；④ `rehydrateFromPersistence` 的 `chargedFailure` 纳入新标志 → `progressed=false`，失败 attempt 计 `attempts`、高水位前进但不因 batch 填充清零；12 次后进入 sticky cap + 30s probe，probe 保留游标，原因移除后从断点 finalize（不重读已扫行）。负控：natural 与 staged 两个（见上表），均断言 cap/probe、cursor/highWater、reads 上界与恢复零重读；另有 barrier unverifiable 计费负控。 |
| medium 1 gate→delivery TOCTOU | `assertPromptSupervision` 现在返回 `SupervisionProof { bindings, corpusBacked }`；新增 `assertSupervisionProofHeld(proof, targetId)`：`!disposed && supervisionIndexComplete && bindingsEqual(proof.bindings, currentCorpusBindings()) && (!corpusBacked || rehydrated)`，失败时 `invalidateSupervision` + 重扫并抛 `DEVLEAD_SESSION_UNAVAILABLE`。复核点：drain/repair barrier 之后、watch 写入之前；`admitPrompt` 入口（resume/interrupt 副作用之前）；真正 `followup/steer/inject` 之前（检查与同步投递之间没有 await，无可插入的替换窗口）。若 interrupt 已提交 stop 后 proof 才失败，按既有 `DevLeadInterruptedAdmissionError` 语义保留 watch（stop 不可回滚，错误要求重试），与既有中断语义一致。负控：冷 Session resume gate 卡住 admission，窗口内 `ctx.set('sessionQuery', replacement)` → 拒绝且 0 followup；新 proof 重证后投递成功；另有 finalize 复核窗口内替换/移除两个负控。 |
| medium 2 dispose | 新增服务生命周期 `rehydrationLifetime` AbortController，plugin dispose effect 里 abort；`verifyCorpusListingNow`（含独立预算的 finalize validation）把内部 controller 接在该 lifetime 上，dispose 立即 abort 已脱离 attempt deadline 的验证读取；`startRehydrationAttempt().extend()` 在 disposed 时 no-op（不再重新 arm deadline）；扫描 outer loop 与 read loop 检查 `this.disposed`。负控：finalize validation listing 挂起时 dispose，attempt 立即 settle（旧行为 test 30s timeout）；direct 负控断言 dispose 后 `extend()` 不会把 controller 加回 `rehydrationAttempts`。 |
| medium 3 文档 | DESIGN §4.1.1 改为“attempt 的 deadline 是分段独立的，不是整次 attempt 只有一个 5s”：扫描阶段 5s、finalize 复核独立 5s、每次 append 批次经 `attempt.extend()` 重新 arm 5s；单次有界 attempt 理论最坏 `5s + ≤3×5s 复核 + ≤2×5s append 批次 ≈ 30s`（append 受 `MAX_FINALIZE_LISTING_REFRESHES=2` 限制），并写明 unverifiable 语义与 dispose/extend 行为。AUDIT §10.2 现状更新、COMPATIBILITY “persistence 就绪信号”假设 1、README/README.zh 冷重建段、OPTIONAL-DEPENDENCIES 同步同一措辞；DESIGN §4.1.1 的 dead 签名 `persistedLeadRecords(scanPersisted, corpusReady)` 改为 `persistedLeadRecords(listing?, signal?, attempt?)`。 |
| minor 1 | `listPersistedSessionsWithin` 的 `Promise.race` loser 挂 `void work.catch(() => undefined)`（与 `awaitScan` 一致），abort 后后端拒绝不会成为 unhandled rejection。 |
| minor 2 | `relistedAfterNotFound`（per attempt 布尔）改为 `relistedFor?: string`（per row/sessionId）：只有**同一** row 的第二次 not-found 才直接计读取失败；行真的消失/新快照重启时清零。负控：30 行 corpus、第 10/20 行各首次 not-found 后成功——per-row 语义下第一个 attempt 内两次 re-list+retry 后即 finalize（旧布尔在第二个 row 会失败并多付一轮重试）。 |
| minor 3 | DESIGN dead 签名已更新（见 medium 3）。 |
| minor 4 | 补 extend 负控：finalize 复核发现 append 行、该行 read 永不 settle——`attempt.extend()` 重新 arm 的 5s 窗口把读取放弃、boot 正常 settle（mutation 删 extend → `bootService did not settle within 60s` 失败）；另有 dispose 后 extend no-op 直接负控。ghost 多位置：新增第 5 行（第一批内）ghost 负控（既有第 90 行覆盖第一批外）。finalize 期间替换（隐藏 foreign supervisor 的新 query Service）与移除（query 在 ground-truth 读取与 listing 读取之间被移除 → unverifiable 保留游标）各一个负控。 |
| minor 5 | 证据修正（见下）：R3 的 e2e “无 false recomposition” 改为证据边界；所有 221/221/198/198 注明含 3 条 SKIP 且 SKIP≠PASS；第四/五轮冻结 commit（仅 reflog 可达）用本地 ref 固定并记录 tree SHA；mutation 表披露 U1-natural mutation 下 staged spy 测试不受该 mutation 影响、由独立 U1-staged mutation 覆盖。 |

新增测试集中在 `packages/devlead/tests/phase2.spec.ts`（60 → **71** 例，+11），全仓 **34 files /
1464 tests**（+11）。新增负控：自然/间歇 listing 失败、staged 恒 unverifiable、barrier
unverifiable 计费、delivery-time proof 复核、finalize validation dispose abort、append 批次
extended deadline / hung read、dispose 后 extend no-op、finalize 窗口内替换、finalize 窗口内
移除、per-row not-found re-list、第一批内 ghost 游标保留。

### 真实时间线

| 时间 | 事实 |
| --- | --- |
| 22:39 | 起点复核：HEAD `7bf4b95`、origin/main `a21c7b7`、工作区干净；读码定位 U1/TOCTOU/dispose/minors |
| 22:42:22 | 未修复树 scratch 复现完成：natural 90s reads 12,064 / lists 241 / attempts 0 / cursor 64；staged 120s reads 16,128 / lists 322 / attempts 0/1（scratch 文件随后删除） |
| 22:43–22:46 | 实现 U1（unverifiable split/retain/charge）、delivery-time proof、dispose lifetime、minor 1/2；scratch 复测：约 40s 内 cap+probe、reads 100/164、原因移除后 0 新增读取恢复 |
| 22:46–22:48 | 写入 11 个正式负控；`npx vitest run packages/devlead/tests/phase2.spec.ts` 71/71；devlead 全包 892/892 |
| 22:48–22:49 | 同步 DESIGN/AUDIT/COMPATIBILITY/README×2/OPTIONAL-DEPENDENCIES 措辞 |
| 22:49:48–22:50:20 | 首轮 `pnpm verify`（含 scratch）35 files / 1465 tests 全过、build 6 targets；`check:packages` OK |
| 22:50:34–22:51:35 | 候选树三条 e2e 全过（该轮 client revision `dcda03c54efd`）；后续最终 verify 重 build 后 rev 变化，故不使用该轮作为最终门禁引用 |
| 22:52:15–22:53:41 | 6 项 mutation 在冻结树重跑：全部 `MUTATION_TEST_EXIT=1`、`RESTORE_CLEAN=true`、`FROZEN_DIFFSTAT_UNCHANGED=true` |
| 22:54:14–22:54:35 | 删除 scratch、新增 finalize-removal 负控后 `pnpm verify`：**34 files / 1464 tests** 全过、build 6 targets；`check:packages` OK |
| 22:54:47–22:56:04 | 该中间树三条 e2e 全过（client revision `95381841504e`）；随后自查补一处一致性：interrupt 已提交 stop 后若 delivery-time proof 复核失败，按既有 `DevLeadInterruptedAdmissionError` 语义保留 watch（生产代码小改动） |
| 22:56–22:57 | 因上述生产代码改动，在最终冻结树（`104aa4d…`）上重跑全部门禁与 mutation |
| 22:57:43–22:58:03 | **最终树** `pnpm verify`：**34 files / 1464 tests** 全过、build 6 targets；`check:packages` OK；`git diff --check` EXIT=0 |
| 22:58:03–22:59:10 | **最终树** 6 项 mutation 全部重跑：全部 `MUTATION_TEST_EXIT=1`、`RESTORE_CLEAN=true` |
| 22:59:14–23:00:31 | **最终树** 三条 e2e：patch **221/221**、installed **221/221**、no-worktree **198/198**；client revision `4098223abe00`；EXIT 全 0 |
| 23:00–23:05 | 以最终树输出更新本证据并本地 commit（未 push、未 bump version、未打 tag） |

### 门禁真实输出（冻结树：`src/index.ts` sha256 `104aa4d…`，代码树与本 commit 相同）

```text
$ pnpm verify
Test Files  34 passed (34)
Tests       1464 passed (1464)
build complete (6 targets)
VERIFY_EXIT=0

$ pnpm check:packages
check-packages: OK (6 packages)
CHECK_PACKAGES_EXIT=0

$ pnpm e2e --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27; phase 1b: 12/12; phase 2: 23/23; phase 3: 125 PASS + 3 SKIP = 128/128; phase 1e: 31/31
  total: 221/221 checks (PASS + SKIP; see per-phase lines)
PATCH_EXIT=0

$ pnpm e2e --flow installed --no-build
E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
  total: 221/221 checks (PASS + SKIP; see per-phase lines)
INSTALLED_EXIT=0

$ pnpm e2e --no-worktree --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  total: 198/198 checks (PASS + SKIP; see per-phase lines); phase 2 skipped (--no-worktree)
NO_WORKTREE_EXIT=0
```

日志（本机，最终冻结树）：`/tmp/dsh-batch1-r6/final4/{e2e-patch,e2e-installed,e2e-no-worktree}.log`；
verify/check/diff-check 日志：`/tmp/dsh-batch1-r6/final4/{verify,check-packages,diff-check}.log`。
最终 e2e client revision `4098223abe00`。更早的 `/tmp/dsh-batch1-r6/final{,-2,-3}/` 与首轮候选树
（client revision `dcda03c54efd`）均被最终树重跑取代，本证据只引用最终树输出。
**SKIP 披露**：三条 e2e 的 3 条 SKIP 都是 phase 3 的 model-selection 检查，原因是本机
provider 的 available model list 不含所请求的 `deepseek-official/deepseek-flash`（无凭据/路由
不可用，SKIP 输出带真实拒绝文案）；`total: 221/221` 是 **PASS + SKIP** 合计，3 条 SKIP 未执行
也不能算通过。此前各轮的 221/221 / 198/198 同样包含这 3 条 SKIP。

### Mutation 负控（冻结树，全部重跑；均 `MUTATION_TEST_EXIT=1`、`RESTORE_CLEAN=true`）

| 场景 | mutation | 目标测试 | 实际失败输出 |
| --- | --- | --- | --- |
| U1-natural | `verifyCorpusListingNow` 的 ground-truth probe 分支把 `{ status: 'unverifiable' }` 改回 `{ status: 'changed' }`（预修复行为：unverifiable 当语料变化） | `charges an intermittently unreadable persistence listing…`（`-t "unverifiable finalize validation|intermittently unreadable"`） | `condition "retry-cap with an intermittently unreadable ground truth" did not settle within 150000ms of advanced time`（始终 cap 不了 = 无界重扫）。同命令下 staged-spy 用例通过：该 mutation 在被 spy 覆盖的方法内部，staged 用例在方法之上打桩，故另设 U1-staged mutation |
| U1-staged | 删除 finalize 复核的 `unverifiable` 保留分支（回落到 changed/丢弃路径） | `charges an always-unverifiable finalize validation…` | `condition "retry-cap with an always-unverifiable validation" did not settle within 100000ms of advanced time`；同时 vitest 报 1 个 unhandled `RangeError: Maximum call stack size exceeded`（未修复语义在 100s fake 内重扫约 1.6 万次触发 cordis 代理递归）——两者都只出现在 mutation 树 |
| TOCTOU | 删除真正投递前的 `assertSupervisionProofHeld(options.proof, targetId)` | `re-checks the corpus binding at delivery time…` | `expected DEVLEAD_SESSION_UNAVAILABLE, but the call succeeded`（prompt 在旧证明下被投递） |
| DISPOSE | 删除 `verifyCorpusListingNow` 的 `lifetime.addEventListener('abort', …)` 接线 | `aborts the finalize validation when the plugin is disposed` | `Error: Test timed out in 30000ms.`（dispose 后验证读取永不返回） |
| RELISTED | `if (relistedFor === sessionId)` 改回 `if (relistedFor !== undefined)`（per-attempt 布尔） | `re-lists each ghost row once…` | `AssertionError: expected false to be true`（首个 attempt 未 finalize） |
| EXTEND | 删除 `attempt?.extend()` | `arms an extended deadline for appended finalize rows…` | `Error: bootService did not settle within 60s of advanced fake time`（append 读取在已停止的 scan deadline 后永远挂着） |

每次 mutation 的完整日志（含 `FROZEN_HEAD=7bf4b95`、冻结树 sha256 `104aa4d…`、mutation diff、
测试输出与 `MUTATION_TEST_EXIT`、恢复后 sha256 与 `RESTORE_CLEAN`）：`/tmp/dsh-batch1-r6/mut/`
（`U1.log`、`U1-STAGED.log`、`TOCTOU.log`、`DISPOSE.log`、`RELISTED.log`、`EXTEND.log`）。
全部 mutation 在最终冻结树（`104aa4d…`）上重跑，恢复后逐项 `RESTORE_CLEAN=true`；未沿用早于冻结树
的日志。

### 证据修正（本轮）

- **R3 的 e2e 结论降级为证据边界**：第五轮 R3 曾写“真实 Host 的 patch/installed e2e 无 false
  recomposition”。e2e 不观测 corpus binding/token、也没有制造替换事件，它只能证明真实 Host 上
  冷重建/prompt 行为无功能回归；生产路径的 binding 语义由生产形状测试（真实 `extends Service`
  fake + 原地 `ctx.set`）与代码路径支撑。已在该行改写并标注“证据边界（第六轮修正）”。
- **SKIP 披露**：见门禁一节的 SKIP 说明；本条适用于本文件此前所有 `221/221` / `198/198` 表述。
- **冻结 commit 可复现性**：第四轮冻结 `d12d9bb`（tree `f43a8621d9c4ba3661159591019ecc7a8d79f63e`）
  与第五轮冻结 `d282f62`（tree `b3ac2b33556edc78b960f8ddf7cb2740c0065d48`）在本轮起点都只经
  reflog 可达（均不是 HEAD 祖先）。已用**本地 ref** 固定：`refs/devlead-evidence/r4-freeze` →
  `d12d9bb`、`refs/devlead-evidence/r5-freeze` → `d282f62`（不 push，不属于 branch/tag）。第五轮
  证据所称“最终 HEAD 的代码树与 d282f62 相同”在本轮起点复核为真：`git diff d282f62 7bf4b95 --
  packages` 为空；本轮不得再引用“仅 reflog 可达”的裸 hash 作为唯一证据。
- 本轮“修复前数字”来自临时 scratch spec（fake timer、100 行 corpus，复现后删除，不作为提交
  内容）；修复后数字全部来自已提交的正式测试断言。候选树与中间树的 e2e（client revision `dcda03c54efd` / `95381841504e`）均被最终冻结树重跑取代，
  本证据只引用最终树输出。

### 残余风险（本轮，非未完成项）

- `unverifiable` 保留游标意味着：若语料真实变化而每一次验证都恰好不可读，DevLead 会保留旧快照
  并持续 fail-closed，直到某次验证成功才发现新增/删除行。这是安全方向（期间 prompt 不授权），
  代价是恢复延迟；12 次 cap + 30s 探针保证它不会退化成热循环，探针也会保留游标继续验证。
- delivery-time 复核与同步投递之间没有 `await`，因此不存在可插入的替换窗口；但若未来把投递改成
  异步/分批，需要把 proof 校验一起带入异步边界。interrupt 已在 stop providers 之后才检查 proof：
  该路径仍可能先请求 stop 再拒绝投递（watch 保留的补偿语义不变，错误文案要求重试），这是既有的
  “stop 不可回滚”取舍，不是新增 fail-open。
- dispose 通过服务 lifetime abort 覆盖 finalize 复核，通过 attempt controllers 覆盖扫描阶段；
  两者之外的第三方后端 promise 若完全忽略 signal，仍会被 `Promise.race` 放弃而不阻塞 Host。
- e2e 不观测 binding 计数/替换（证据边界见上）；真实安装版只覆盖“无替换”的正常组合。
- 本轮的“单次 attempt 最坏约 30s”是理论上界（5s 扫描 + ≤3 次独立复核 + ≤2 次 append 批次），
  实际启动通常只需一次扫描 + 一次复核；持续慢后端会在每个窗口被放弃并计失败，不会永久挂起。
- mutation 与 e2e/verify 日志保存在本机 `/tmp`，不随仓库提交；本地证据 ref 不 push。
