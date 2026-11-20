# Batch 2：dsh-devlead 0.4.0-rc.1 发布准备 — 版本、门禁与发布检查证据

日期：2026-11-20（Asia/Shanghai；Batch 2 准备门禁实际执行时间 2026-11-20 23:20–23:22；
文档修复后的门禁复跑时间见下文「文档修复后复跑」）
基线：`main @ a35fc1d`（Batch 1 最终提交，独立审查第七轮 **FINAL: SAFE**）
运行 DSH：安装版 **0.2.2-rc.5**（`dsh --version`；基线 pin 与 `scripts/e2e-smoke.mjs` 的
`BASELINE_DSH_VERSION` 一致）。工具链：Node 26.13.0、pnpm 12.16.1、npm 11.20.0。

本文件记录 **0.4.0-rc.1 发布准备**（Batch 2）的真实输出：版本清单、`pnpm verify` /
`pnpm check:packages`、三条真实 E2E、staged-publish dry-run、npm pack 内容核对。所有日志由
本轮冻结树实际生成并随本文件提交；**未引用任何旧轮次日志**。准备 commit 之后又做了一轮纯文档
修复并复跑门禁，见下文「文档修复后复跑」。本批**未 push、未打 tag、未 npm publish/stage**。

## 冻结树

准备 commit（`ce1b284`）门禁运行时的树 = `HEAD a35fc1d` + 本批未提交改动（7 个 workspace
manifest 的 `version` 行、7 个文档文件、新增 `docs/releases/v0.4.0-rc.1.md`）。`packages/` 的
代码与 Batch 1 最终树完全相同，`packages/` 差异只有 6 个包的 `version` 字段：

```text
$ git rev-parse HEAD
a35fc1dc86ef76d45411274764e22bbbfb950e33

$ git diff a35fc1d --stat -- packages
 packages/bundle/package.json    | 2 +-
 packages/client-ui/package.json | 2 +-
 packages/command/package.json   | 2 +-
 packages/devlead/package.json   | 2 +-
 packages/protocol/package.json  | 2 +-
 packages/tool/package.json      | 2 +-
 6 files changed, 6 insertions(+), 6 deletions(-)
# 差异内容仅为 `-  "version": "0.3.0-rc.2"` / `+  "version": "0.4.0-rc.1"`

$ git diff --check
（无输出）DIFF_CHECK_EXIT=0
```

Batch 1 的 7 个本地 commit（`a21c7b7..a35fc1d`，43 files +8974/−834，tree
`e39ca88…`）与最终门禁见 [`batch1-breaking-correctness.md`](batch1-breaking-correctness.md)；
Batch 2 准备 commit 未修改该证据文件，**文档修复轮**补正了其中的 staged `reads=164→100`、
冻结身份 tree SHA 与 mutation 时间线（见下文「文档修复后复跑」）。

## 版本清单（0.4.0-rc.1）

7 个 workspace manifest（根 private 包 + 6 个可发布包；`scripts/e2e-probe/package.json` 为
`0.0.0`、非 workspace、不发布，不在 grep 范围）统一 bump；`grep` 结果恰好 7 行：

```text
$ git grep -n '"version": "0.4.0-rc.1"' -- package.json packages/*/package.json
package.json:3:  "version": "0.4.0-rc.1",
packages/bundle/package.json:3:  "version": "0.4.0-rc.1",
packages/client-ui/package.json:3:  "version": "0.4.0-rc.1",
packages/command/package.json:3:  "version": "0.4.0-rc.1",
packages/devlead/package.json:3:  "version": "0.4.0-rc.1",
packages/protocol/package.json:3:  "version": "0.4.0-rc.1",
packages/tool/package.json:3:  "version": "0.4.0-rc.1",
```

`pnpm-lock.yaml` / `pnpm-workspace.yaml` **不记录本仓库自身的版本**（lockfile v9 的 importer
只记录依赖），因此无需、也**没有**手工改 lockfile。bump 后执行：

```text
$ pnpm install --frozen-lockfile
Scope: all 7 workspace projects
✓ Lockfile passes supply-chain policies
Lockfile is up to date, resolution step is skipped
Done in 23ms using pnpm v12.16.1
INSTALL_EXIT=0
```

`engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）与全部 `@deepseek-ai/dsh-*` peer 范围**不随插件版本
变化**；DSH 兼容面仍是 `0.2.2-rc.1` – `0.2.2-rc.5`。

### 文档/README 中的版本引用

| 文件 | `0.4.0-rc.1` 出现次数 | 关键位置 |
| --- | --- | --- |
| `README.md` | 11 | 顶部 breaking 段（#50）、E2E 候选行（#370–372）、候选说明（#374）、安装精确版本（#435–439）、promote 示例（#1420–1421） |
| `README.zh.md` | 11 | 顶部 breaking 段（#38）、E2E 候选行（#312–314）、候选说明（#316）、安装（#330–333）、promote 示例（#1129–1130） |
| `docs/COMPATIBILITY.md` | 9 | 版本声明（#4）、breaking 清单（#252–258）、升级门禁（#317/#326）、真实 E2E 收口（#470–471） |
| `docs/PUBLISHING.md` | 40 | bump 模板（#145–149）、prerelease 预检（#191–195）、发布检查（#220）、tag/commit（#250–253）、发布后校验（#345–349）、首 RC checklist（#366+）、dist-tag 策略与历史（#459–495） |
| `docs/DESIGN.md` | 22 | 当前契约（#15–24）、§4.4 状态（#1009）、Batch 1/Batch 2 记录、决策记录、证据索引 |
| `docs/releases/v0.4.0-rc.1.md` | 12 | release notes 正文 |
| `docs/releases/v0.3.0.md` | 0（1 处链接到 rc 文件） | 顶部注明 0.3.0 稳定版未发布、内容并入 0.4.0 线 |

全仓扫描 `0.3.0-rc.2`（排除历史 release notes 文件 `docs/releases/v0.3.0-rc.2.md`）后剩余
引用**全部是有意的**，无当前版本残留：

- `README.md` / `README.zh.md` / `docs/PUBLISHING.md`：npm `next` dist-tag **当前真实指向**
  `0.3.0-rc.2`（promote 前事实，必须写）。
- `docs/releases/v0.4.0-rc.1.md`：「自 0.3.0-rc.2 以来的内容」、回滚注意、promote 前后 dist-tag、
  已推送 tag `v0.3.0-rc.1`/`v0.3.0-rc.2` 保持原样。
- `docs/COMPATIBILITY.md`：回滚到 `0.3.0-rc.2` 隐含 reset 的升级说明。
- `docs/DESIGN.md`：Batch 1 记录（当时版本仍是 0.3.0-rc.2）、决策记录中的历史版本口径。
- `docs/releases/v0.3.0.md`：指向历史 rc release notes 的链接。

## 最终门禁（真实输出）

门禁脚本对每条命令 `> log 2>&1` 后追加真实 `<GATE>_EXIT=<code>`。执行顺序与完成时间
（本机 2026-11-20，Asia/Shanghai）：

| 门禁 | 命令 | 结果 | 完成时间 |
| --- | --- | --- | --- |
| `pnpm verify` | typecheck + test + build | 34 files / 1464 tests + 6 targets，`VERIFY_EXIT=0` | 23:21:15 |
| `pnpm check:packages` | 包不变式 | `OK (6 packages)`，`CHECK_PACKAGES_EXIT=0` | 23:21:15 |
| e2e patch | `pnpm e2e --no-build` | **221/221**（218 PASS + 3 SKIP），`PATCH_EXIT=0` | 23:21:40 |
| e2e installed | `pnpm e2e --flow installed --no-build` | **221/221**（218 PASS + 3 SKIP），`INSTALLED_EXIT=0` | 23:22:06 |
| e2e no-worktree | `pnpm e2e --no-worktree --no-build` | **198/198**（195 PASS + 3 SKIP），`NOWORKTREE_EXIT=0` | 23:22:30 |
| release:dry（guard） | `pnpm release:dry` | 按设计拒绝 prerelease+latest，`RELEASE_DRY_LATEST_GUARD_EXIT=1` | 23:22:30 |
| release:dry（正确形式） | `node scripts/stage-release.mjs --dry-run --dist-tag next` | `DRY RUN OK`（6 包），`RELEASE_DRY_EXIT=0` | 23:22:31 |
| npm pack 内容核对 | `/tmp/batch2-pack-inspect.sh` | 6 包文件清单/版本/workspace 改写全部符合预期，`PACK_INSPECT_EXIT=0` | 23:22:32 |

原始日志：`batch2-verify.log`、`batch2-check-packages.log`、`batch2-e2e-patch.log`、
`batch2-e2e-installed.log`、`batch2-e2e-no-worktree.log`、
`batch2-release-dry-latest-guard.log`、`batch2-release-dry.log`、`batch2-pack-inspect.txt`。

**commit 前最终树复跑**（在写入本证据/回填文档数字之后，即实际提交的树上再跑一次，证明
文档改动没有影响门禁；23:23:51 完成）：`pnpm verify` → 34 / **1464 tests** + 6 targets，
`FINAL_VERIFY_EXIT=0`；`pnpm check:packages` → `OK (6 packages)`，
`FINAL_CHECK_PACKAGES_EXIT=0`；`git diff --check` → `DIFF_CHECK_EXIT=0`（日志
`batch2-final-verify.log`、`batch2-final-check-packages.log`）。三条 E2E 的代码树与冻结门禁树
相同（`packages/` 无改动），因此不重复执行。

### 文档修复后复跑（2026-11-20，最终文档树）

Batch 2 准备 commit `ce1b284` 之后又做了一轮**纯文档修复**（release notes 与 round-7
FINAL SAFE 的 known limitations 对齐、范围账目/breaking 归属、UI-VERIFICATION 增补
0.4.0-rc.1 视觉项、PUBLISHING `NOWORKTREE_EXIT`、日期、DESIGN Proposed 行/残余项、batch1
evidence 的 `reads=164→100` 与 tree SHA，以及 `packages/devlead/src/fold.ts` 的过期 JSDoc
注释）。本节所用日志在该修复树（尚未 commit；`packages/` 只有 6 处 `version` 行与 fold.ts 一处
注释相对 Batch 1 树，无运行时行为变化）上重跑；wrapper 把 `VERSION` / `GIT_HEAD` /
`GIT_TREE` 直接 echo 进每条日志（回应“门禁日志缺少 version/rev”的 nit）。注意：日志里的
`GIT_HEAD`/`GIT_TREE` 是门禁起点 HEAD `ce1b284` 的值，门禁树 = 该 tree + 未提交的文档修复
（日志头的 `WORKTREE_DOC_CHANGES` 记录改动文件数）；门禁由 commit 前的最终工作树生成，与
Batch 2 准备轮相同：

```text
VERSION=0.4.0-rc.1
GIT_HEAD=ce1b284d776e4a50de9120d16fa4ba57508d8b61
GIT_TREE=0101ba09442b647d0c8b6333d4517aea80f8412a
```

| 门禁 | 命令 | 结果 | 完成时间 |
| --- | --- | --- | --- |
| `pnpm verify` | typecheck + test + build | 34 files / **1464 tests** + 6 targets，`EXIT=0` | 23:39:41–23:40:01 |
| `pnpm check:packages` | 包不变式 | `check-packages: OK (6 packages)`，`EXIT=0` | 23:40:01 |
| e2e patch | `pnpm e2e --no-build` | **221/221**（218 PASS + 3 SKIP），`EXIT=0` | 23:40:27 |
| e2e installed | `pnpm e2e --flow installed --no-build` | **221/221**（218 PASS + 3 SKIP），`EXIT=0` | 23:40:52 |
| e2e no-worktree | `pnpm e2e --no-worktree --no-build` | **198/198**（195 PASS + 3 SKIP），`EXIT=0` | 23:41:17 |
| `git diff --check` | 工作区 diff | `DIFF_CHECK_EXIT=0`（未跟踪的新日志不计入） | 23:40:01 |

该修复轮最终提交为 `ddc2113`（`docs(release): fix 0.4.0-rc.1 known limitations and doc
drift`），**tree SHA = `ef6096da896fd6e96c2488ec937e5a419dcd2db6`**（`git rev-parse
ddc2113^{tree}`），即上表门禁所对应文档树的最终提交身份。**避免 overstated**：三条 e2e 的
**运行时工作树含文档改动**（日志头 `WORKTREE_DOC_CHANGES=8`，起点是 `ce1b284` 树
`0101ba0…`），其运行时代码与 `ce1b284` 相同——`packages/` 相对 `ce1b284` 只有 `fold.ts`
一处 JSDoc 注释，相对 Batch 1 树另有 6 处 `version` 行，均无运行时行为变化；final
verify/check-packages 在写入本证据后的最终文档树上复跑（见本节末段），日志中的
`GIT_HEAD`/`GIT_TREE` 是门禁起点的值而非该 tree。

日志：`batch2-docfix-{verify,check-packages,e2e-patch,e2e-installed,e2e-no-worktree,diff-check}.log`
与元数据 `batch2-docfix-gates-meta.log`；该轮 e2e 的 client revision 为 `6056fe8a1305`（重
build 后的 mtime hash，与准备 commit 的 `72a61091babf` 不同，但 `packages/` 代码未变）。

**raw log 保真说明**：上述三个 e2e 日志各保留 1 行原始输出末尾空格（`PASS notification
records the provider failure ...`），与准备 commit 的 `batch2-e2e-*.log` 相同；`git diff
--cached --check` 会对此报 whitespace warning，这是 raw-log fidelity 取舍（日志即原始终端
输出，CI 不检查 docs 日志），不是格式回归。**本轮选择保留 raw 原样、不 trim**（trim 会改变
原始输出）：三个 log 已随 `ddc2113` 提交、内容不再改动，因此后续轮次的 `git diff --check` 为
0；如需复现该 warning，对引入日志的提交运行 `git diff ddc2113^ ddc2113 --check`（3 条
trailing whitespace，退出码 2）。

随后在**更新完本证据后的最终文档树**上再跑一次 `pnpm verify` / `pnpm check:packages`
（23:43:21–23:43:41，`EXIT=0`；日志 `batch2-docfix-final-verify.log` /
`batch2-docfix-final-check-packages.log` / `batch2-docfix-final-diff-check.log`，同样带
version/rev echo；结果 34/1464 + 6 targets、`OK (6 packages)`），确认证据更新没有影响门禁。

### 发布前文档 nit 修复后复跑（2026-11-20，polish）

发布前又在 `ddc2113`（tree `ef6096da…`）之上做一轮**纯文档 nit 修复**：release notes 的
`packages/` 与 `fold.ts` JSDoc 措辞对齐、UI-VERIFICATION 视觉项与编号步骤排版、本证据补
tree identity 与 e2e 工作树边界说明；不改代码、不改版本、不新增运行时行为。门禁在 polish
工作树上复跑，wrapper 同样把 `VERSION` / `GIT_HEAD` / `GIT_TREE` / `WORKTREE_DOC_CHANGES` /
`PACKAGES_CHANGED` echo 进每条日志：

| 门禁 | 命令 | 结果 | 完成时间 |
| --- | --- | --- | --- |
| `pnpm verify` | typecheck + test + build | 34 files / **1464 tests** + 6 targets，`EXIT=0` | 23:52:09–23:52:29 |
| `pnpm check:packages` | 包不变式 | `check-packages: OK (6 packages)`，`EXIT=0` | 23:52:29 |
| `git diff --check` | 工作区 diff | `EXIT=0`（未跟踪的新日志不计入） | 23:52:29 |

日志：`batch2-polish-{verify,check-packages,diff-check}.log` 与元数据
`batch2-polish-gates-meta.log`（`GIT_HEAD=ddc2113…`、`GIT_TREE=ef6096da…`、
`PACKAGES_CHANGED=0`，即 `git diff ddc2113 -- packages` 无输出；版本仍 `0.4.0-rc.1`，
工作树改动全部在 `docs/`）。**三条 e2e 本轮不重跑**：运行时代码与 `ce1b284` 相同（见上节
的 e2e 工作树说明），`ddc2113` 轮的三条 e2e 日志继续有效，且本轮未修改这三个 raw log 文件。
随后在**写入本证据后的最终文档树**上再跑一次 `pnpm verify` / `node scripts/check-packages.mjs`
（日志 `batch2-polish-final-verify.log` / `batch2-polish-final-check-packages.log` /
`batch2-polish-final-diff-check.log` 与 `batch2-polish-final-gates-meta.log`；结果同为
34 files / **1464 tests** + 6 targets、`check-packages: OK (6 packages)`，`EXIT=0`），确认
证据更新没有影响门禁。polish 轮是 docs-only 本地 commit，其 tree SHA 由交付说明给出
（提交对象无法在自身 tree 内嵌自己的 tree hash，可用 `git rev-parse <commit>^{tree}` 复核）。

### `pnpm verify` / `check:packages`

```text
$ pnpm verify
 ✓ packages/devlead/tests/phase2.spec.ts (71 tests) 17843ms
 Test Files  34 passed (34)
      Tests  1464 passed (1464)
build complete (6 targets)
VERIFY_EXIT=0

$ pnpm check:packages
check-packages: OK (6 packages)
CHECK_PACKAGES_EXIT=0
```

### 三条真实 E2E（安装版 DSH 0.2.2-rc.5）

```text
$ pnpm e2e --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1 (default profile): 27/27 checks
  phase 1b (cold lead rehydration): 12/12 checks
  phase 2 (experimental worktree composition): 23/23 checks
  phase 3 (close tools, dispatch routing, and triage policy): 128/128 checks
  phase 1e (message lanes, merge, action cap, metrics): 31/31 checks
  total: 221/221 checks (PASS + SKIP; see per-phase lines)
PATCH_EXIT=0

$ pnpm e2e --flow installed --no-build
E2E SMOKE PASS (installed, DeepSeek Harness 0.2.2-rc.5)
  total: 221/221 checks (PASS + SKIP; see per-phase lines)
INSTALLED_EXIT=0

$ pnpm e2e --no-worktree --no-build
E2E SMOKE PASS (patch, DeepSeek Harness 0.2.2-rc.5)
  phase 1: 27/27; phase 1b: 12/12; phase 3: 128/128; phase 1e: 31/31
  total: 198/198 checks (PASS + SKIP; see per-phase lines); phase 2 skipped (--no-worktree)
NOWORKTREE_EXIT=0
```

PASS/SKIP 真实拆分为 **218 PASS + 3 SKIP = 221**（patch、installed 各）与
**195 PASS + 3 SKIP = 198**（no-worktree）。3 条 SKIP 都是 phase 3 的正向模型选择检查，原因由
日志打印：本机 provider 的 available model list 不含所请求的
`deepseek-official/deepseek-flash`。**SKIP 未执行、不能算通过**；负向模型路径、
`devlead_list_models`、preset roster 与 watched-child `devlead_report` 均真实运行。

### staged-publish dry-run（不 publish / 不 tag / 不 push）

**guard（预期失败）**：根 script `pnpm release:dry` 固定默认 `--dist-tag latest`，对 prerelease
按设计拒绝且不上传/不产生 stage id：

```text
$ pnpm release:dry
build complete (6 targets)
stage-release failed: version 0.4.0-rc.1 is a prerelease; staging it with --dist-tag latest
would make it the default install once approved. Use --dist-tag next (or another non-latest tag)
for prereleases.
No package was staged by this run.
RELEASE_DRY_LATEST_GUARD_EXIT=1
```

**正确形式**（本 RC 的预检；`pnpm build` 已由 `pnpm verify` 完成）：

```text
$ node scripts/stage-release.mjs --dry-run --dist-tag next
stage-release: DRY RUN (no upload) — version 0.4.0-rc.1, dist-tag next
npm 11.20.0 / pnpm 12.16.1
provenance: no
[1/6] dry-run OK @yankeguo/dsh-devlead-protocol@0.4.0-rc.1 (7 files, ...tgz)
[2/6] dry-run OK @yankeguo/dsh-client-ui-devlead@0.4.0-rc.1 (7 files, ...tgz)
[3/6] dry-run OK @yankeguo/dsh-devlead@0.4.0-rc.1 (6 files, ...tgz)
[4/6] dry-run OK @yankeguo/dsh-command-devlead@0.4.0-rc.1 (6 files, ...tgz)
[5/6] dry-run OK @yankeguo/dsh-tool-devlead@0.4.0-rc.1 (6 files, ...tgz)
[6/6] dry-run OK @yankeguo/dsh-devlead-bundle@0.4.0-rc.1 (7 files, ...tgz)
DRY RUN OK: packed and preflighted 6 packages; nothing was uploaded and no stage id was created.
RELEASE_DRY_EXIT=0
```

`--dry-run` 仍会经 npm CLI 做打包/参数校验；`--force` 只跳过 registry“版本已存在”检查，不做
任何上传，也不创建 stage id。

### npm pack 内容与 expected files 核对

用 `pnpm --filter ./packages/<dir> pack` 打包（`pnpm pack` 会改写 `workspace:` 协议）并逐包
`tar -tzf` 核对。6 个 tarball 的 `package.json.version` 均为 `0.4.0-rc.1`，均不含 `workspace:`，
workspace 依赖全部改写为精确 `0.4.0-rc.1`：

| 包 | tarball 内文件数 | 实际文件（= 预期） |
| --- | --- | --- |
| `@yankeguo/dsh-devlead-protocol` | 7 | `LICENSE`、`README.md`、`package.json`、`lib/index.js`、`lib/client.js`、`locale/en.json`、`locale/zh.json` |
| `@yankeguo/dsh-client-ui-devlead` | 7 | 同上（`lib/index.js` + `lib/client.js`） |
| `@yankeguo/dsh-devlead` | 6 | `LICENSE`、`README.md`、`package.json`、`lib/index.js`、`locale/en.json`、`locale/zh.json` |
| `@yankeguo/dsh-command-devlead` | 6 | 同上 |
| `@yankeguo/dsh-tool-devlead` | 6 | 同上 |
| `@yankeguo/dsh-devlead-bundle` | 7 | `LICENSE`、`README.md`、`package.json`、`cordis.patch.yml`、`icon.svg`、`locale/en.json`、`locale/zh.json` |

与各包 `files` 字段 / `exports`（含 `./client`、`./cordis.patch.yml`）一致；`bundle` 不产出 JS
（patch-only）。打包临时目录在系统 temp 下，未污染仓库（`packages/*/lib/` 被 gitignore，构建
产物不提交）。完整逐文件输出见 [`batch2-pack-inspect.txt`](batch2-pack-inspect.txt)。

## 发布检查（按 PUBLISHING §「0.4.0-rc.1 首 RC 发布步骤与检查」）

- [x] **(a) 版本 lockstep**：7 个 workspace manifest（根 + 6 个可发布包）均 `0.4.0-rc.1`
  （grep 恰好 7 行）；
  `pnpm install --frozen-lockfile` 通过；未手改 lockfile。
- [x] **(b) release notes 就绪**：`docs/releases/v0.4.0-rc.1.md` 存在且非空（GitHub Release 正文）。
- [x] **(c) stage 前门禁**：`pnpm verify`、`pnpm check:packages`、`stage-release --dry-run
  --dist-tag next`（`DRY RUN OK`）通过；三条真实 e2e 带真实 `*_EXIT=0` 与 pin 计数（本文件）。
- [ ] **(d) 浏览器可视验收（人工）**：待人类按 [UI-VERIFICATION](../UI-VERIFICATION.md) 在隔离
  profile 走查（composer 开关、DevLeadBar 三 lane 配色、question 状态/`provisional`、侧栏
  active ring/watched 准星）。e2e 与渲染测试只覆盖 projection/DOM/断言，不替代人工验收。
- [ ] **(e) 人类批准 tag**：`git tag -a v0.4.0-rc.1 -m "v0.4.0-rc.1"` + push（CI 以 `next`
  stage 6 包，不公开）——**本批未执行**，等待人类明确指示。
- [ ] **(f) 人工 approve（2FA）**：`promote-release.mjs --version 0.4.0-rc.1` —— **本批未执行**。
- [ ] **(g) 发布后三方核对**：6 包 `@0.4.0-rc.1` + `dist-tags.next=0.4.0-rc.1` +
  `latest` 仍 `0.2.6` + GitHub Release 指向同一 tag/commit —— 发布后执行。
- [x] **(h) 升级门禁提示**：release notes / COMPATIBILITY / PUBLISHING 已记录旧 state 不迁移、
  `/devlead reset`、`questionTtlMs` 24h、`actionRequiredBatchMs`、multi-lead 硬门禁。
- [x] **(i) dist-tag 注意**：prerelease 禁止 `latest`（guard 实测拒绝）；`@next` 24h 内不可用于
  安装（`0.0.0-stage` 回退）；tag 不移动/不删除/不重建 —— 已写入 PUBLISHING。
- [x] **(j) 只改文档后的重试**：reject 旧 staged id + 从同一既有 tag 重跑 stage，不移动 tag ——
  已写入 PUBLISHING checklist。

当前 registry 事实（npm view，2026-11-20）：`latest=0.2.6`、`next=0.3.0-rc.2`；`0.4.0-rc.1`
**尚未** published/staged。promote 后预期：`next=0.4.0-rc.1`、`latest=0.2.6`。

## 残余风险 / 未做项

- **本批未 push、未打 tag、未 stage/publish**：发布的三段流程（tag → CI stage → 人工 approve）
  全部等待人类批准；commit 是本地 commit。
- **浏览器可视验收未做**：本机无截图工具；自动化证据只到 projection/DOM/渲染断言层，发布前
  必须完成 PUBLISHING checklist 的人工项。
- **未做真实 registry 安装 smoke**：e2e 的 `installed` 流用 profile 符号链接等价路径，不是
  registry 下载；首次发布后仍需在干净 profile 上按 PUBLISHING 做一次 registry 安装冒烟。
- **v1→v2 旧数据迁移路径未做真实 backend smoke**（沿用 Batch 1 声明）：旧 record/outbox 数据
  按设计显式丢弃；本 workspace 不解析 storage-json/sqlite backend 依赖，未新增依赖。
- **3 条 e2e SKIP**：无 provider 凭据的正向模型选择检查未执行，已按 SKIP 披露，不冒充 PASS。
- **慢 listing / delivery-time TOCTOU / `possibleQuestion` / blocking bridge / 人工视觉验收**等
  已知限制与决策记录见 [`docs/releases/v0.4.0-rc.1.md`](../releases/v0.4.0-rc.1.md)、
  [DESIGN §12](../DESIGN.md)、[COMPATIBILITY](../COMPATIBILITY.md) 与
  [PUBLISHING](../PUBLISHING.md)。

## 相关证据

- Batch 1： [`batch1-breaking-correctness.md`](batch1-breaking-correctness.md)（准备 commit 未改动；
  文档修复轮补正 `reads=164→100`、冻结身份 tree SHA 与 mutation 时间线）
- Phase 1e / 1d 历史轮次：见 [DESIGN §12 证据索引](../DESIGN.md)
- 本批原始日志：`batch2-*.log`、`batch2-pack-inspect.txt`（同目录）
