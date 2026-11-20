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
| 17:49–17:59 | 独立复核的 3 项问题及后续 2 个边界修复后，`pnpm verify`：34 files / **1400 tests** 全过，`check:packages` 再次 OK；复核结论：未发现 blocker |
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
| 19:00:59 | M2 mutation（普通 user/message 重新计入 presented）：liveness 测试按预期失败，`M2_MUTATION_EXIT=1`；随后恢复源码 |
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

## Delta 复核追加：cold index 状态机与重试恢复

独立 delta 复核指出的晚绑定 fail-open 与不完整后永久 fail-closed 已关闭：

- query/persistence 出现后的每次重扫先清除旧的 live-only 授权，readiness/完整扫描结束前不得利用旧 `true` 放行；阻塞 read 的负控返回 `DEVLEAD_SESSION_UNAVAILABLE`。
- 只有完整扫描才 `finalizeRehydration()`；不完整时保留 `rehydrated=false`，在 `rehydrateFromPersistence.finally` 清理旧 hook 并重新调度 optional-service / 250ms 重试，避免 timer 已在扫描中触发后没有后续 retry。disposed 路径不再创建 effect。
- 首次 no-cache 不完整后，晚装 projectionCache 的第二次扫描成功，合法 prompt 恢复；首次扫描超过 250ms 且失败，在无新注入时也由 finally 重新调度并恢复。capped 断言改为每次扫描最多 65 次读取，允许合法重试。
- 原审查者最终 delta 结论：**未发现剩余 blocker**。

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
