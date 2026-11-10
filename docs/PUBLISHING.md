# 发布指南

本仓库是一个 pnpm workspace，包含 **6 个可发布包**（4 个运行时插件包 + 1 个纯类型包 + 1 个 bundle）：

| 发布顺序 | 包 | 说明 |
| --- | --- | --- |
| 1 | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），声明 `devLead` projection 类型 |
| 2 | `@yankeguo/dsh-client-ui-devlead` | 浏览器两态 UI：工具条开关、DevLeadBar、侧边栏会话行标记 |
| 3 | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式、Workspace/Session 编排、监督索引、通知投递、projection fold |
| 4 | `@yankeguo/dsh-command-devlead` | `/devlead` 人类命令 |
| 5 | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| 6 | `@yankeguo/dsh-devlead-bundle` | 安装入口 bundle（`cordis.patch.yml` 装齐整套） |

所有包使用同一个版本号。发布时先把 6 个包按 workspace 依赖拓扑排序（上表即脚本的确定性顺序：
依赖先打包、bundle 最后；同层按包名排序），**依赖先 stage/approve、bundle 最后**；
`pnpm pack` 会把 `workspace:*` 改写为当前精确版本（例如 `0.2.0`）。`npm pack` / 从包目录直接
`npm publish` **不会**改写 `workspace:`，因此发布链路固定使用 pnpm 打包，详见下文脚本说明。

## 发布模型：CI 只 stage，人工 approve，再出 GitHub Release

发布分为三个明确阶段：

| 阶段 | 执行者 | 认证 | 动作 |
| --- | --- | --- | --- |
| **1. Stage（暂存）** | `.github/workflows/publish.yml`（推 tag 或手动 dispatch） | GitHub Actions OIDC 短时 token（`id-token: write`） | 构建、校验、`npm stage publish` 上传 6 个包的暂存版本。**不发布任何东西。** |
| **2. Approve（批准 = 发布）** | 仓库维护者本地 | `npm login` 登录凭据 + 交互式 2FA OTP | `scripts/promote-release.mjs` 逐个审批 staged 版本；npm 每批准一个就立即公开该包 |
| **3. Release（GitHub Release）** | 同一个本地脚本 | `gh auth login` | 全部批准后创建/更新 GitHub Release（幂等，`--verify-tag`） |

这样设计的原因：

- **原子发布**：某个版本的任何包在全部 stage 完成并且人工批准整套之前都不会公开。构建坏包、
  CI 中途失败、版本错位都不会让用户装到半套版本。
- **CI 没有发布权**：工作流不持有任何长期 npm token，只有每个包对应的短时 OIDC token；
  npm 只在 `npm stage publish` / `npm publish` 时接受 OIDC token，`npm stage list/approve/reject`
  **只能由人类登录执行**（approve/reject 还需要交互式 2FA）。即使工作流被篡改，最多也只能
  stage 一个未批准版本。
- **可重跑、可审计**：stage 产物带 provenance；审批前的 staged id 全部打印在 CI job summary 里；
  发布顺序和批准人（actor）都能在 `npm stage list` 中看到。

旧的“CI 直接 `pnpm publish -r` + CI 创建 GitHub Release”模型已废弃。PR / push 到 main 仍由
[`verify.yml`](../.github/workflows/verify.yml) 跑安装、typecheck、test、build、`check:packages`；
它不碰 registry，也不需要任何凭据。

## 前置条件

- Node.js ≥ 24.9、pnpm `12.16.1`（`corepack enable` 或直接安装）。
- **npm ≥ 11.15.0**：staged publishing（`npm stage` 系列命令与 `npm trust --allow-stage-publish`）
  从 11.15.0 开始提供；本仓库 CI 固定并校验 **11.20.0**（`npm install -g npm@11.20.0`）。
  本地发布/审批前请安装同一版本（用 `npm stage --help` 自检）。
- npm 账号对 `@yankeguo` scope 有写权限；所有包都声明了 `publishConfig.access: public`。
- npm 账号已开启 **2FA**：approve / reject 必须交互式输入一次性密码（OTP）。
- 包必须**已存在于 npm registry**：npm 的 trusted publishing 只对已发布的包生效，新包的
  **首次发布**是一次性手工操作（见下文“新包首次发布”）。
- GitHub Actions 运行在 **GitHub-hosted runner**（npm 目前不支持 self-hosted runner 的 trusted
  publishing）。
- 仓库公开（`yankeguo/dsh-devlead`）：provenance 需要公开仓库 + 公开包；仓库下 npm CLI 会
  自动附带 provenance。

## 一次性配置：npm 信任发布者（只允许 staged publishing）

npm 只接受来自“被信任的 CI 工作流”的 OIDC 发布请求。每个包要配置一次，把
**本仓库 + `publish.yml` 工作流** 声明为该包的 trusted publisher，并且**只授予
staged publishing 权限**（`--allow-stage-publish`）。

> **从旧配置迁移（重要）**：历史上用 `--allow-publish` 创建的 trust 配置只允许
> `npm publish`，**不会**授权 `npm stage publish`。如果包上已经有旧配置，CI 会报
> 401/403 或 trust 校验错误。必须先 revoke 旧配置，再用本节的脚本重建：
>
> ```sh
> npm trust list <package>                 # 找到 GitHub Actions 记录的 id
> npm trust revoke <package> --id=<id>     # 撤销旧的 publish-only 配置
> scripts/trusted-publishers.sh            # 用 --allow-stage-publish 重建
> ```

### 方式 A：脚本批量配置（推荐）

```sh
npm login                                 # 确认是 @yankeguo 维护者
npm install -g npm@11.20.0                # 仓库固定 11.20.0；npm stage 自 11.15.0 提供
scripts/trusted-publishers.sh --dry-run   # 先看会做什么
scripts/trusted-publishers.sh             # 逐个配置全部 6 个包（脚本自动发现）
scripts/trusted-publishers.sh --list      # 校验结果
```

脚本对每个包相当于执行：

```sh
npm trust github @yankeguo/dsh-devlead \
  --file publish.yml \
  --repo yankeguo/dsh-devlead \
  --allow-stage-publish \
  --yes
```

- 脚本先用 `npm trust --help`（要求 npm ≥ 11.15）和 `npm stage --help`（要求 npm ≥ 11.20）
  做能力探测，再跳过 `private` 包；`--list` 在未登录 / 查询失败时以非零码退出；
- 脚本**只会**传 `--allow-stage-publish`，绝不传 `--allow-publish`：直发权限对 CI 没有用处，
  而 stage 权限才是工作流需要的；
- `--file` 必须只是工作流文件名（`publish.yml`），不能带路径，且文件必须位于
  `.github/workflows/` 下；
- 若使用 GitHub Environments 做发布审批，加 `--env <环境名>`，并同时在工作流 job 上写
  `environment: <环境名>`，两边必须一致（本仓库默认不使用 environment）；
- 每个包最多 10 个 trusted publisher；同一包已有配置时需先
  `npm trust list <package>` 找到 id，再 `npm trust revoke <package> --id=<id>`，然后重建；
- npm 建议批量配置时每次调用间隔约 2 秒（脚本已处理）。

### 方式 B：npmjs.com 网页配置

包的 npmjs.com 页面 → **Settings → Trusted Publisher → GitHub Actions**，填写：

| 字段 | 值 |
| --- | --- |
| Organization or user | `yankeguo` |
| Repository | `dsh-devlead` |
| Workflow filename | `publish.yml` |
| Environment name | 留空（或与工作流 `environment` 一致） |
| Allowed actions | 勾选 **npm stage publish**（不要依赖旧的 npm publish 配置） |

6 个包都要各配一次（脚本会自动遍历 `packages/*/package.json`，新增包无需改脚本）。

### 校验

```sh
scripts/trusted-publishers.sh --list
# 或
npm trust list @yankeguo/dsh-devlead
```

输出里应能看到 6 个包都指向 `publish.yml` / `yankeguo/dsh-devlead`；如果所用 npm 版本在
`npm trust list` 中显示授权动作字段，确认只包含 staged publishing（不允许旧的 `--allow-publish`
直发记录残留）。

## 发版流程

### 1. 准备干净的 main

```sh
git checkout main
git pull
git status                 # 必须干净
```

### 2. 统一升级 6 个包的版本

所有包使用同一版本号。一行命令改完（示例 `0.3.0`）：

```sh
export VERSION=0.3.0
node -e '
  const fs = require("node:fs")
  const files = ["package.json"]
  for (const dir of ["protocol","devlead","tool","command","client-ui","bundle"]) {
    files.push(`packages/${dir}/package.json`)
  }
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.version = process.env.VERSION
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
  }
  console.log("bumped to", process.env.VERSION)
'
pnpm install                # 同步 workspace 锁文件中的版本
```

> 不要只发布部分包：bundle 依赖整套包的同一版本；CI 的 tag 门禁和本地 promote 都要求
> 根 `package.json` 与 6 个可发布包版本完全一致。

### 3. 写 release notes（promote 的硬性前置条件）

新建 `docs/releases/v<VERSION>.md`（参考 [`v0.2.0.md`](releases/v0.2.0.md)）。
`scripts/promote-release.mjs` 会用它作为 GitHub Release 正文，**文件不存在或为空时拒绝批准**
（避免包已公开却没有发布说明）。

### 4. 发布前检查

```sh
pnpm install --frozen-lockfile     # 锁文件一致
pnpm typecheck                     # TS 检查（含 noUnusedLocals/Parameters）
pnpm test                          # 单元测试（vitest）
pnpm build                         # 生成 packages/*/lib（lib 被 gitignore，必须现构建；共 7 个 lib/*.js）
pnpm check:packages                # 包不变式：版本/engines/peer 规则/DSH 依赖/实验包/模块表/client inject/别名/lockfile/CI pin
pnpm release:dry                   # = pnpm build && node scripts/stage-release.mjs --dry-run
                                   #   本地打包 + npm 预检，不上传、不创建 stage id
```

`pnpm build` 产出 7 个 `lib/*.js`：protocol 的 `index`/`client`、core、tool、command、
client-ui 的 `index`/`client`；`bundle` 只有 patch 文件与 icon，不产出 JS。

可选（本机，需要已安装的 DSH 桌面端）：真实 DSH 端到端冒烟：

```sh
pnpm e2e                          # 默认组合（阶段 1 + 1b + 2，全过报 61/61）
pnpm e2e --flow installed         # 已安装形态的安装流
pnpm e2e --no-worktree            # 跳过实验 forge bundle 组合（报 39/39）
```

`release:dry` 的本地预检说明：

- 脚本用 `pnpm pack` 打包 6 个包到系统临时目录，逐个校验 tarball 内 `package.json` 的版本、
  `workspace:` 已全部改写、workspace 依赖版本等于发布版本；
- 然后以临时目录为 cwd 调用
  `npm stage publish <tarball> --access public --tag latest --dry-run --force --json`；
- **`--dry-run` 仍会做 registry 的“版本已存在”检查**，所以本地预检加了 `--force` 跳过该检查
  （真实 stage 永远不加 `--force`）；
- 输出 `DRY RUN OK` 表示 6 个包都能打包并通过 npm CLI 的打包/参数校验；`--force` 跳过了
  registry 的“版本已存在”检查，因此 dry-run 不验证 registry 状态。不会上传任何内容，也不会
  产生 stage id。

### 5. 触发 CI stage（推荐路径）

```sh
git add -A
git commit -m "release: v0.3.0"
git push origin main
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0                 # 触发 .github/workflows/publish.yml
```

`publish.yml` 的行为：

1. **Checkout 指定 tag**（push：`github.ref`；手动 dispatch：`inputs.release_tag` 对应的
   `refs/tags/<tag>`，`fetch-depth: 0` 取全量历史与 tag）。
2. **Resolve and verify the release tag**：`git fetch --tags`，确认 `refs/tags/<tag>` 指向的
   commit 与当前 `HEAD` 一致，并从 tag 推导版本号；不一致直接失败（**CI 不会创建、移动或删除
   tag**）。prerelease tag（版本号带 `-rc`/`-alpha` 等后缀）也会在此步被拒绝：CI 只 stage
   稳定版（`latest`），预发布请走本地 stage。这一步在安装依赖之前执行，坏 tag 数秒内失败。
3. 安装 pnpm `12.16.1`、Node `24`，并显式安装/校验 **npm 11.20.0**（`npm stage --help` 能力探测）。
4. **tag-version 门禁**：`v<version>` 必须与 6 个可发布包 + 根 `package.json` 的 `version` 完全一致。
5. `pnpm install --frozen-lockfile` → typecheck → test → build → `node scripts/check-packages.mjs`。
6. **Stage**：`node scripts/stage-release.mjs --version "$RELEASE_VERSION" --dist-tag latest`。
   每个包打印一行 stage id，并写入 job summary；失败时停止并打印已 stage 的包与修复提示。
7. **Release summary**：仅在全部 stage 成功后写入下一步人工审批命令。

工作流权限（已声明）：

```yaml
permissions:
  contents: read      # GitHub Release 由本地 promote 脚本创建，CI 不需要写权限
  id-token: write     # OIDC：npm CLI 换取逐个包的短时 token（仅能 stage）
```

第三方 action 使用与 `verify.yml` 相同的精确版本（`actions/checkout@v7.0.1`、
`pnpm/action-setup@v6.1.1`、`actions/setup-node@v7.1.0`），`scripts/check-packages.mjs` 会校验
两个工作流 pin 完全一致、pnpm/node 版本、`id-token: write` 与 `verify.yml` 的只读权限。

**手动 dispatch（补发/重跑）**：Actions → `publish` → Run workflow，`release_tag` 必须填
**已存在**的 tag（例如 `v0.3.0`）。工作流只认既有 tag；**不要删除、重建或移动 tag**。
dispatch 与 tag push 共用并发组 `publish`，不会交错 stage。

### 6. 人工批准（本地，2FA）

维护者在本机执行：

```sh
npm login                                  # 确认是 @yankeguo 维护者，账号已开 2FA
npm install -g npm@11.20.0                 # 若尚未安装（仓库固定 11.20.0；npm stage 自 11.15.0 提供）

node scripts/promote-release.mjs --dry-run # 预检 + 打印计划，不做任何变更
node scripts/promote-release.mjs           # 逐包 approve（npm 会提示输入 OTP），然后建 GitHub Release
```

`promote-release.mjs` 的两阶段行为：

**阶段 A：只读预检**（任一失败都不会批准任何包）

- 验证根 `package.json` 与 6 个包版本一致、npm 已登录、npm 支持 `npm stage`；
- 对每个包执行 `npm stage list <pkg> --json`，过滤出 `packageName === <pkg>` 且
  `version === <发布版本>` 的记录：
  - **恰好 1 条**：批准它；
  - **0 条但该版本已发布**：视为已完成（重跑/断点续传幂等），跳过；
  - **0 条且未发布**：先对 `npm view` 做有限次重试（最多 4 次、间隔约 1.5s）再判定 ——
    刚 approve 的版本可能还没出现在读路径里，避免把“已发布但尚未传播”误判为缺失；仍不存在
    才失败，提示先跑发布工作流；
  - **多于 1 条**：失败并列出全部 staged id（必须人工决定 reject 哪一条）；
- 验证 `gh` 已认证、有仓库权限、`gh release view` 可查（结果缓存给阶段 B 使用）；
- 验证 release tag **已在远端存在**（`gh api repos/<repo>/git/ref/tags/<tag>`，本脚本不会创建
  tag），验证 release notes 文件存在且非空；
- 按 workspace 依赖拓扑顺序打印 approve 计划与第 N 步 GitHub Release 动作。

**阶段 B：串行批准**

- 逐个执行 `npm stage approve <stage-id>`，stdio 继承，npm 自己提示并读取 OTP；
- 每个包批准后**立即公开**；中途失败会停止并打印：已公开的包、仍处于 staged 的包的 id、
  `npm stage reject <id>` 清理提示、以及重跑命令；
- 全部批准后按阶段 A 缓存的 release 存在性执行 `gh release create|edit <tag>
  --repo <repo> --title <tag> --notes-file docs/releases/v<version>.md --verify-tag`
  （幂等；`--verify-tag` 保证只使用已存在的 tag）。

脚本参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--version <x.y.z>` | 根 `package.json` 版本 | 要批准的发布版本 |
| `--release-tag <tag>` | `v<version>` | GitHub Release tag；必须已存在，脚本绝不创建/移动 tag |
| `--repo <owner/repo>` | 从 origin remote 推导 | GitHub 仓库 |
| `--notes-file <path>` | `docs/releases/v<version>.md` | Release 正文文件（相对路径从仓库根解析） |
| `--dry-run` | 关闭 | 完整只读预检 + 打印计划，不批准、不创建 Release |
| `--list-only` | 关闭 | 只打印各包 staged 状态（临时排障/清理用），不检查 gh/notes、不变更 |

### 7. 发布后校验

```sh
npm view @yankeguo/dsh-devlead-bundle@0.3.0 version dist-tags
npm view @yankeguo/dsh-devlead@0.3.0 version
npm view @yankeguo/dsh-command-devlead@0.3.0 version

gh release view v0.3.0 --repo yankeguo/dsh-devlead
```

npmjs.com 上每个包应显示 **provenance / attestation**（公开仓库 + GitHub-hosted runner 自动生成）。

在 DSH 中安装验证：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.3.0
```

然后刷新 Web 页面，开一个会话执行 `/devlead on`，再让模型
`devlead_use_workspace` + `devlead_create_session` 做一次冒烟。

## 新包首次发布（一次性手工操作）

npm 的 trusted publishing 要求包**已经存在**于 registry。新增第 7 个包时，第一次发布只能人工做
（不能用 OIDC，因为此时还没有 trust 配置可匹配）：

```sh
# 1) 必须用 pnpm pack：它会改写 workspace:* 依赖（npm pack / 从包目录 npm publish 不会）
rm -rf /tmp/devlead-first-publish && mkdir -p /tmp/devlead-first-publish
pnpm --filter @yankeguo/<new-package> pack --pack-destination /tmp/devlead-first-publish

# 2) 手工发布 tarball（npm 会提示 2FA OTP）；stage publish/approve 同理可用
cd /tmp/devlead-first-publish
npm login
npm publish ./*.tgz --access public --tag latest

# 3) 回到仓库，为该包配置只允许 staged publishing 的 trusted publisher
scripts/trusted-publishers.sh --dry-run
scripts/trusted-publishers.sh
scripts/trusted-publishers.sh --list
```

之后该包即走正常的 CI stage → 人工 approve 流程。若新包被 bundle 依赖，把它加进 workspace 后
`pnpm install` 会同步锁文件；下一次整套发版会按拓扑顺序带上它。

## 版本与 dist-tag 策略

- 稳定版：默认 `latest`。CI 固定以 `--dist-tag latest` stage；promote 批准后即成为 `latest` 对应的
  已发布版本。
- 试验版/预发布：**CI 会在 tag 校验阶段直接拒绝 prerelease tag**（见工作流），请在本地以其他
  dist-tag stage：
  ```sh
  npm login
  node scripts/stage-release.mjs --dist-tag next          # 或 --version 0.3.0-rc.1
  node scripts/promote-release.mjs --version 0.3.0-rc.1
  ```
  用户安装时需要显式指定版本（DSH 插件市场按版本安装，不受 dist-tag 影响）。
- `engines.dsh` 当前为 `>=0.2.2-rc.1 <0.3.0`，**所有插件 / bundle 包都声明**；
  DSH 升级到 0.3 时需更新该范围并回归。
- 破坏性变更：遵循 semver；预发布版本使用 `-rc.N` / `-alpha.N` 后缀。
- 最近一次发版为 **0.2.0**（minor，含 breaking）：`isolation` 必填字段正式声明、
  `useWorkspace(agent, request)` + `create` 默认 `false`、`wakeColdSession` 默认 `true`、
  `promptSession` 的 watch 补偿、`hasQueuedNotice` 保留 batch、`/devlead reset` + 冻结恢复、
  以及 nits（React 渲染测试、样式 refcount 等）。0.2.0 发布时已同步 README / README.zh /
  `docs/releases/v0.2.0.md`，并复核旧 core + 新 tool 混装时 `isolation` 的防御性降级
  （tool 对缺失字段回退 `{requested:'none',status:'none'}`）。
- 每次发版前同步 README / README.zh 与 `docs/releases/v<version>.md`，并确认 6 个包与根
  `package.json` 的 `version` 已一起 bump。

## 脚本参考

### `scripts/stage-release.mjs`（CI / 本地 stage）

按 workspace 依赖拓扑顺序打包并 stage 全部可发布包；不发布任何内容。

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `--version <x.y.z>` | 期望版本；默认根 `package.json` 版本。必须与根 + 6 个包一致，否则失败 |
| `--dist-tag <tag>` | npm dist-tag，默认 `latest`；不允许写成版本号 |
| `--dry-run` | 打包 + `npm stage publish --dry-run --force` 预检，不上传、不创建 stage id |
| `--no-provenance` | 即使在 GitHub Actions 中也不传 `--provenance` |
| `GITHUB_ACTIONS=true` | 传 `--provenance`（npm 也会对公开包自动启用 provenance） |
| `GITHUB_STEP_SUMMARY` | 设置时把 staged 版本表写进 Actions job summary |

脚本会断言：根/包版本 lockstep、拓扑顺序确定、每个 tarball 的 manifest 版本正确、tarball 内不再
包含 `workspace:`、workspace 依赖值等于发布版本。任一包失败即停止，打印已 stage 的包、stage id
与修复提示（**不打印假的 stage id**；只有 npm 真实返回的 stage id 才会被记录）。临时 tarball
目录在结束时删除，不污染仓库。

### `scripts/promote-release.mjs`（维护者本地 approve + Release）

参数见上文“人工批准”一节。要点：

- 预检对每个包要求**恰好一条**匹配 staged 记录；已发布视为幂等完成（`npm view` 未命中时会做
  有限次 registry 传播重试，避免把刚 approve、尚未可见的版本误判为缺失）；重试后仍缺失才失败；
- approve 顺序与发布顺序一致（依赖先公开，bundle 最后），每个 approve 由 npm 交互式读取 OTP；
- 失败时给出已公开列表、剩余 staged id、`npm stage reject` 与重跑指引；
- GitHub Release 幂等创建/更新，`--verify-tag` 保证不新建 tag；本地 HEAD 与 tag 不一致时只警告
  （promote 读取 registry 与 notes 文件，不依赖本地构建产物）。

### 根 `package.json` scripts

| script | 等价命令 | 用途 |
| --- | --- | --- |
| `pnpm release:dry` | `pnpm build && node scripts/stage-release.mjs --dry-run` | 本地打包 + npm 预检（不上传） |
| `pnpm release:stage` | `pnpm build && node scripts/stage-release.mjs` | 本地 stage（需 `npm login`；CI 不需要它） |
| `pnpm release:promote` | `node scripts/promote-release.mjs` | 人工批准 + GitHub Release |

原 `release:publish`（直接 `pnpm publish -r`）已删除：CI 不再直接发布，本地也不需要整体直发命令。

## 故障恢复

### CI stage 部分失败

1. `stage-release.mjs` 会在失败处停止并打印**已 stage 的包 + stage id**，job summary 也会保留一张
   表；此时**没有任何版本公开**。
2. 修复失败原因（常见：trusted publisher 仍是旧的 `--allow-publish` 配置、npm 版本不对、网络）。
3. **推荐恢复方式**：先把这次失败留下的 staged 记录全部 reject，再从干净状态重跑 CI：
   ```sh
   npm login
   npm stage list <package> --json      # 找出本次失败运行的 staged id
   npm stage reject <stage-id>          # 对每条 staged 记录执行（不可恢复，谨慎）
   ```
   然后 Actions → `publish` → Run workflow → `release_tag` 填**同一个既有 tag**。
   CI 会重新 stage 全部 6 个包，provenance 也重新生成。
4. 如果上一次运行其实**全部 6 个包都 stage 成功**，不要重跑 stage：直接用
   `node scripts/promote-release.mjs` 完成发布。

> 为什么不能“只补 stage 失败的包”？`npm stage list` 只允许人类登录查询，CI 无法知道哪些包已
> staged；而重复 stage 同一版本的结果没有保证（可能被 registry 拒绝，也可能留下多条同版本
> staged 记录）。因此“先 reject 本次残留记录、再用同一既有 tag 全量重跑”是最干净、可预测的
> 恢复路径。

### promote 中途失败

- 已 approve 的包**已经公开**，无法撤销（见“误发版本”）。`promote-release.mjs` 重跑是幂等的：
  已发布的包会被跳过（`npm view` 暂时查不到时会有限次等待 registry 传播），只继续批准剩余
  staged 的包 —— 修复原因后直接重跑同一条命令即可。
- 如果失败发生在最后的 GitHub Release 步骤：所有包都已公开，只需修好 `gh` 认证/网络后重跑
  promote（会走 `gh release edit/create --verify-tag`），不会重复发布。

### 其它典型情况

| 现象 | 处理 |
| --- | --- |
| 某个包出现**多条** matched staged 记录 | 先 `npm stage view <id> --json` 看 createdAt/shasum，再 `npm stage reject <id>` 清掉多余记录；每次运行只保留一条 |
| staged 了**错误 commit** 的版本 | reject 该版本的全部 staged id，确认 tag/commit 后再 dispatch 同一 tag（不会移动 tag） |
| CI 重跑报“版本已 staged / 已发布”或出现重复 staged 记录 | 说明上次运行已 stage（或该版本已发布）。重复 stage 同版本可能被拒绝、也可能新增一条 staged 记录（registry 行为未验证）；先 `npm stage list <pkg> --json` 核对：6 个包全部已 stage → 直接 promote；只 stage 了一部分 → reject 本次残留记录后从同一既有 tag 全量重跑 |
| 版本已经发布 | 不能再次 stage/publish 同版本；升版本重新发版（72 小时内可 `npm unpublish`，见下） |
| 想用 workflow_dispatch 重跑 | `release_tag` 必须是已存在的 tag；工作流校验 tag commit == HEAD。**不要删除/重建/移动 tag** |
| tag 不存在 | `git push origin <tag>` 推送既有 tag；本工作流与 promote 脚本都不会创建 tag |
| 误发版本 | npm 允许 72 小时内 `npm unpublish <pkg>@<version>`；超过则只能 `npm deprecate` 并升版本 |

### 首次 CI 运行的验证清单

- [ ] `scripts/trusted-publishers.sh --list` 显示 6 个包均已配置 `publish.yml` / `yankeguo/dsh-devlead`，
      且授权动作为 staged publishing（没有旧的 `--allow-publish` 配置残留）
- [ ] 本地 `npm --version` ≥ 11.15.0（建议与 CI 一致的 11.20.0）；CI 日志出现 “npm 11.20.0 supports staged publishing”
- [ ] tag 已 push，且 CI 的 “Resolve and verify the release tag” 通过（tag commit == HEAD）
- [ ] “Verify the release tag matches every package version” 通过（6 包 + 根版本一致）
- [ ] “Stage packages on npm (publishes nothing)” 打印 6 个 stage id；job summary 有 staged 表
- [ ] 此时 `npm view <pkg>@<version>` **仍应 404**（还没有公开），`npm stage list <pkg> --json`
      每个包恰好一条记录
- [ ] 本地 `node scripts/promote-release.mjs --dry-run` 计划正确（6 个 approve + 1 个 Release）
- [ ] approve 后 `npm view <pkg>@<version> version dist-tags` 正常，npmjs.com 显示 provenance
- [ ] `gh release view v<version> --repo yankeguo/dsh-devlead` 指向同一 tag 与 commit
- [ ] 仓库 secrets 中没有 `NPM_TOKEN`（本模型不需要任何 npm secret）

## 安全说明与 provenance

1. 工作流声明 `permissions: id-token: write` 后，GitHub Actions 通过
   `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 暴露 OIDC ID token 获取端点
   （每个 job/每次运行都是新的短时 token）。
2. npm CLI（不是 pnpm）检测到该环境后，请求受众为 `npm:registry.npmjs.org` 的 ID token，向
   registry 的 `/-/npm/v1/oidc/token/exchange/package/<pkg>` 换取**一次性的 stage token**；
   也可通过 `NPM_ID_TOKEN` 传入（npm CLI 直接使用该 token；audience 由 registry 侧校验）。
3. npm 侧校验 OIDC claims（仓库、工作流文件名、可选 environment）与包的 trusted publisher 配置
   一致，并且配置允许 staged publishing，然后接受 stage 请求。
4. token 短时且绑定具体工作流；CI 不能 list/approve/reject（这些需要人类登录，approve/reject
   还需要交互式 2FA）。
5. provenance 由 npm CLI 在 OIDC token 交换成功后生成（Sigstore）：需要公开仓库 + 公开包；
   CI 中 `stage-release.mjs` 显式传 `--provenance`，npm 也会对公开包自动启用。本地 stage
   （`npm login` 凭据）不产生 provenance；如不需要可加 `--no-provenance`。
6. 发布顺序、stage 记录与 provenance 均可在 npmjs.com / registry 审计；GitHub Release 的 tag 固定
   指向 CI 构建的 commit。

> pnpm 版本要求：本仓库 CI 固定 `pnpm@12.16.1`，但 staged publishing / OIDC / provenance 全部由
> **npm CLI** 完成；CI 因此显式安装并固定 `npm@11.20.0`。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| CI 报 401/403 / `no trust evidence` / trust 校验错误 | trusted publisher 配置与本次运行不匹配，或配置是旧的 `--allow-publish`（不允许 stage）。核对 repo、**工作流文件名**、environment；必要时 `npm trust list` → `npm trust revoke --id` → `scripts/trusted-publishers.sh` 重建 |
| CI 报 `ENEEDAUTH`（stage 阶段） | 工作流缺少 `id-token: write`，或该包还没有匹配的 trusted publisher（先手动首次发布再配置） |
| CI 报 `npm: command not found` / `npm stage` 不存在 | runner 上的 npm < 11.15.0（工作流已显式安装并校验 11.20.0）；若仍失败检查 npm 安装步骤日志 |
| `npm stage list` 报 401/ENEEDAUTH | 本地未 `npm login`，或登录凭据不可用于该操作；list 需要人类登录，approve/reject 还需要交互式 2FA；OIDC token 无效 |
| approve 报 `EOTP` / OTP 错误 | OTP 输错或过期；重跑 `node scripts/promote-release.mjs` 重新输入。也可手工 `npm stage approve <id>` 后重跑 promote（会跳过已批准项） |
| promote 报 “no staged version and no published version” | CI 未运行或 stage 失败；先跑发布工作流（tag push 或 dispatch 既有 tag），看到 6 个 stage id 后再 promote |
| promote 报 “has N staged records” | 同一版本存在多条 staged 记录：`npm stage view <id> --json` 比较，`npm stage reject` 清掉旧记录后重试 |
| CI 重跑报版本已存在 / staged 记录重复 | 上次已 stage 或该版本已发布。重复 stage 同版本可能被拒绝、也可能新增一条 staged 记录（registry 行为未验证）：先 `npm stage list <pkg> --json` 核对，全部已 stage 则直接 promote；只 stage 了一部分则 reject 本次残留记录后从同一既有 tag 全量重跑 |
| `Cannot publish over the previously published versions` | 该版本已发布，不能覆盖；升版本（并统一 6 个包）后再发 |
| promote 报 `release tag ... does not exist` | 先把既有 tag push 到 origin；promote 与 CI 都不会创建/移动 tag |
| promote 报 notes 文件不存在/为空 | 先写 `docs/releases/v<version>.md`，或用 `--notes-file` 指定 |
| GitHub Release 创建失败 | 所有包已公开；修好 `gh auth`/网络后重跑 promote，或手工 `gh release create <tag> --verify-tag --title <tag> --notes-file <file>` |
| provenance 未生成 | 仓库非公开、runner 非 GitHub-hosted、或本地 stage（本地不生成）；公开仓库 + hosted runner 会在 CI 中生成 |
| 想改用新工作流文件名/环境 | 一个包只能存在一个 trust 配置：先 `npm trust list` + `npm trust revoke --id`，再用 `scripts/trusted-publishers.sh` 重建 |
| 误发版本 | npm 允许 72 小时内 `npm unpublish <pkg>@<version>`；超过则只能废弃（deprecate）并升版本 |

## 发布后的用户安装方式

```sh
# CLI
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-devlead-bundle
```

本地 checkout 开发仍可用 `pnpm install:profile`（见主 [README.zh.md](../README.zh.md)）。

## 插件展示元数据（`locale/*.json`）

DSH 插件管理器与插件市场显示的是每个插件的**用户友好标题与一句话描述**，而不是 npm 包名和
技术性 `description`。DSH 0.2.2-rc.1 的 `readPluginMeta` 在**不执行插件代码**的前提下读取：

1. `<包名>/locale/en.json`（必须能通过 Node ESM `exports` 解析）；
2. 同目录其它 `<语言>.json` 作为翻译（语言 ID 取文件名小写，例如 `zh.json`）；
3. 字段缺失时回落到 `package.json` 的 `name` / `description`；bundle 的 manifest `icon`
   字段提供图标（相对路径、位于包目录内、≤ 256 KiB、SVG/PNG/JPEG/WebP）。

因此每个可发布包都提供 `locale/en.json` 与 `locale/zh.json`：

```json
{
  "meta": {
    "title": "DevLead Tools",
    "description": "Model-facing devlead_* tools available only in DevLead mode: list and use Workspaces, create and prompt Sessions, read session status, watch Sessions, and read notifications."
  }
}
```

并在 `package.json` 中接线：

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": ["lib", "locale/*.json", "README.md"]
}
```

约束由 `pnpm check:packages` 与 `packages/devlead/tests/plugin-metadata.spec.ts` 强制
（CI 的 `verify.yml`、`publish.yml` 都会跑 `check-packages`，不满足时会在发布前失败）：

- 每个可发布包同时具备 `locale/en.json` + `locale/zh.json`；`meta.title`、`meta.description`
  均为非空字符串，中英文语义一致；
- 标题在整套包内唯一；描述是一句准确的功能说明，**不使用营销词 / 最高级**；
- bundle `@yankeguo/dsh-devlead-bundle` 保留 `icon` 字段，且 `files` 包含图标与 locale 文件。

当前 6 个包的展示标题：DevLead Protocol / DevLead / DevLead Tools / DevLead Command /
DevLead UI / DevLead Suite（中文分别为 DevLead 协议 / DevLead / DevLead 工具 / DevLead 命令 /
DevLead 界面 / DevLead 套件）。

### 新增可发布包清单

1. `packages/<pkg>/package.json`：`files` 增加 `locale/*.json`，`exports` 增加
   `"./locale/*.json": "./locale/*.json"`；
2. 新增 `locale/en.json` + `locale/zh.json`（用户友好 `meta.title` / `meta.description`）；
3. 运行 `pnpm check:packages` 与 `pnpm test`（新增包会被自动遍历，无需改测试或校验脚本）；
4. 发布/安装后在 DSH 插件管理器确认标题、描述与图标；也可在发布前用 `npm pack` / `pnpm pack`
   检查 tarball 含 `package/locale/en.json` 与 `package/locale/zh.json`。

### 发布后验证展示效果

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@<version>
```

刷新 Web 页面 → **Plugins / 插件**：bundle 应显示 **DevLead Suite**（中文界面为
**DevLead 套件**）与一句话描述、原有 icon；各子插件包显示各自的 DevLead * 标题。

## 参考

- npm staged publishing：[npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage)、`npm help stage`
- npm 文档：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- `npm trust` 命令：`npm help trust` / [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- pnpm：[pnpm pack](https://pnpm.io/cli/pack)（改写 `workspace:` 协议）、[pnpm publish](https://pnpm.io/cli/publish)
- OpenSSF [Trusted Publishers](https://repos.openssf.org/trusted-publishers) 标准
