# 发布指南

本仓库是一个 pnpm workspace，包含 **6 个可发布包**（4 个运行时插件包 + 1 个纯类型包 + 1 个 bundle）：

| 顺序 | 包 | 说明 |
| --- | --- | --- |
| 1 | `@yankeguo/dsh-devlead-protocol` | 纯类型 + 常量 + 格式化（host 与浏览器共用），声明 `devLead` projection 类型 |
| 2 | `@yankeguo/dsh-devlead` | 核心 Service `ctx.devLead`：模式、Workspace/Session 编排、监督索引、通知投递、projection fold |
| 3 | `@yankeguo/dsh-tool-devlead` | 模型工具 `devlead_*` + 条件系统提示 |
| 4 | `@yankeguo/dsh-command-devlead` | `/devlead` 人类命令 |
| 5 | `@yankeguo/dsh-client-ui-devlead` | 浏览器 DevLead 状态条 |
| 6 | `@yankeguo/dsh-devlead-bundle` | 安装入口 bundle（`cordis.patch.yml` 装齐整套） |

`pnpm publish -r` 会按依赖拓扑自动排序，**功能包先发、bundle 最后发布**；
bundle 的 `workspace:*` 依赖在打包时会被改写为当前精确版本（`0.1.0` 等）。

## 两种发布方式

| 方式 | 认证 | 适用 |
| --- | --- | --- |
| **CI + npm Trusted Publishing（OIDC，推荐）** | GitHub Actions 的短时 OIDC token，**无需任何 npm secret** | 推 `v*` tag 自动发布 + 创建 GitHub Release |
| 本地手动 | `npm login` 的长期会话凭据 | 首次发布新包、紧急补发、调试 |

CI 方式在仓库里已经配置好（[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）：
推 tag → install / typecheck / test / build / `pnpm publish -r` → GitHub Release。
工作流里 **没有 `NODE_AUTH_TOKEN`、也没有 `NPM_TOKEN`**，只依赖 `id-token: write` 权限。

## 前置条件

- Node.js ≥ 24.9、pnpm 12（`corepack enable` 或直接安装 pnpm 12.x）。
- npm 账号对 `@yankeguo` scope 有写权限；所有包都声明了 `publishConfig.access: public`。
- npm 账号已开启 **2FA**（`npm trust` 命令要求；CI 的 OIDC 发布本身不需要 2FA）。
- GitHub Actions 运行在 **GitHub-hosted runner**（npm 目前不支持 self-hosted runner 的 trusted publishing）。
- 仓库是公开仓库（`yankeguo/dsh-devlead`）：trusted publishing 可在私有仓库使用，但
  **provenance 需要公开仓库**；公开仓库下 pnpm 会自动附带 provenance。

## 一次性配置：npm 信任发布者（Keyless OIDC）

npm 只接受来自"被信任的 CI 工作流"的 OIDC 发布请求。每个包都要配置一次，
把 **本仓库 + `publish.yml` 工作流** 声明为该包的 trusted publisher。

### 前提

1. **包必须已经存在于 npm registry**（npm 的硬性要求）：新包第一次发布只能走
   `npm login` 手动发布或 `NPM_TOKEN`，之后才能配置 trusted publisher。
2. `npm trust` 命令要求 **npm ≥ 11.15.0**、账号开启 2FA，且登录凭据不能是
   "bypass 2FA" 类型的 Granular Token。

### 方式 A：脚本批量配置（推荐）

```sh
npm login                                # 确认是 @yankeguo 维护者
npx npm@latest --version                 # 确保 >= 11.15.0
scripts/trusted-publishers.sh --dry-run  # 先看会做什么
scripts/trusted-publishers.sh            # 逐个配置全部 6 个包（脚本自动发现）
scripts/trusted-publishers.sh --list     # 校验结果
```

脚本等价于对每个包执行：

```sh
npm trust github @yankeguo/dsh-devlead \
  --file publish.yml \
  --repo yankeguo/dsh-devlead \
  --allow-publish \
  --yes
```

- `--file` 必须只是工作流文件名（`publish.yml`），不能带路径，且文件必须位于
  `.github/workflows/` 下；
- `--allow-publish` 允许直接 `pnpm publish`（自 2026-09-03 起新建配置默认只允许
  staged publish，必须显式授权直接发布；我们使用直接发布）；
- 若使用 GitHub Environments 做发布审批，加 `--env <环境名>`，并同时在工作流 job 上写
  `environment: <环境名>`，两边必须一致；
- 每个包最多 10 个 trusted publisher；同一包已有一个配置时需先
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
| Allowed actions | 勾选 **npm publish**（按需再加 npm dist-tag） |

6 个包都要各配一次（脚本会自动遍历 `packages/*/package.json`，新增包无需改脚本）。

### 校验

```sh
scripts/trusted-publishers.sh --list
# 或
npm trust list @yankeguo/dsh-devlead
```

## 发版流程

### 1. 准备干净的 main

```sh
git checkout main
git pull
git status                 # 必须干净
```

### 2. 统一升级 6 个包的版本

所有包使用同一版本号。一行命令改完（示例 `0.2.0`）：

```sh
export VERSION=0.2.0
node -e '
  const fs = require("node:fs")
  const dirs = ["protocol","devlead","tool","command","client-ui","bundle"]
  for (const dir of dirs) {
    const file = `packages/${dir}/package.json`
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.version = process.env.VERSION
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
  }
  console.log("bumped to", process.env.VERSION)
'
pnpm install                # 同步 workspace 锁文件中的版本
```

> 也可以只发布部分包，但**不要**让 bundle 依赖的版本与已发布版本不一致；
> 推荐整套同版本发布。发布前检查所有包的 `version` 一致。

### 3. 写 release notes

新建 `docs/releases/v<VERSION>.md`（参考 [`v0.1.0.md`](releases/v0.1.0.md)）。
CI 会用它作为 GitHub Release 正文。

### 4. 发布前检查

```sh
pnpm install --frozen-lockfile     # 锁文件一致
pnpm typecheck                     # TS 检查
pnpm test                          # 单元测试（vitest）
pnpm build                         # 生成 packages/*/lib（lib 被 gitignore，必须现构建；共 7 个 lib/*.js）
pnpm release:dry                   # 递归 dry-run：打印 6 个包的发布计划，不上传
```

`pnpm build` 产出 7 个 `lib/*.js`：protocol 的 `index`/`client`、core、tool、command、
client-ui 的 `index`/`client`；`bundle` 只有 patch 文件与 icon，不产出 JS。

抽查打包内容（可选，但推荐在首次发布或改 `files` 后做）：

```sh
mkdir -p /tmp/devlead-pkgs
pnpm --filter @yankeguo/dsh-devlead-bundle pack --pack-destination /tmp/devlead-pkgs
pnpm --filter @yankeguo/dsh-client-ui-devlead pack --pack-destination /tmp/devlead-pkgs

BUNDLE=/tmp/devlead-pkgs/*dsh-devlead-bundle-*.tgz
UI=/tmp/devlead-pkgs/*dsh-client-ui-devlead-*.tgz
tar -tzf $BUNDLE        # 必须包含 package/cordis.patch.yml、icon.svg、README.md
tar -tzf $UI            # 必须包含 package/lib/client.js 与 package/locale/*.json
tar -xzOf $BUNDLE package/package.json   # workspace:* 应已改写为精确版本
```

### 5. 发布

**A. 推 tag 触发 CI（推荐，keyless OIDC）**

```sh
git add -A
git commit -m "release: v0.2.0"
git push origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0                 # 触发 .github/workflows/publish.yml
```

CI 在安装依赖前会先跑一个 **tag 一致性门禁**：`v<version>` tag 必须与全部 6 个可发布包和根
`package.json` 的 `version` 完全一致，否则 job 直接失败（避免 tag / npm 版本错位）。
工作流需要以下权限（已在 workflow 中声明）：

```yaml
permissions:
  contents: write     # 创建 GitHub Release
  id-token: write     # OIDC：pnpm 换取 npm 短时 token
```

pnpm 检测到 GitHub Actions 的 OIDC 环境后会自动完成 token 交换；公开仓库 + 公开包
会**自动附带 provenance**（无需 `--provenance` 参数）。`workflow_dispatch` 也支持手动触发，
但不带 tag 时不会创建 Release。

工作流里的第三方 action 使用精确版本（`actions/checkout@v7.0.1`、`pnpm/action-setup@v6.1.1`、
`actions/setup-node@v7.1.0`），Node 24 + pnpm `12.16.1`。

**B. 本地手动发布（首次发布新包 / 紧急补发）**

```sh
npm login                              # 确保是 @yankeguo 的维护者
pnpm release:publish                   # = pnpm build && pnpm publish -r --access public --no-git-checks --tag latest
```

本地发布仍使用传统凭据（`npm login` 或 `NODE_AUTH_TOKEN`），与 OIDC 并行可用；
OIDC 只是在 CI 中**取代**长期 token。

### 6. 验证发布结果

```sh
npm view @yankeguo/dsh-devlead-bundle version dist-tags
npm view @yankeguo/dsh-devlead version
npm view @yankeguo/dsh-command-devlead version
```

在 DSH 中安装验证：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle@0.1.0
```

然后刷新 Web 页面，开一个会话执行 `/devlead on`，再让模型
`devlead_use_workspace` + `devlead_create_session` 做一次冒烟。

## Keyless OIDC 工作原理（研究笔记）

1. 工作流声明 `permissions: id-token: write` 后，GitHub Actions 通过
   `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
   暴露一个 OIDC ID token 获取端点（每个 job、每次运行都是新的短时 token）。
2. `pnpm publish` 检测到该环境后，用自己的 identity 请求一个受众为
   `npm:registry.npmjs.org` 的 ID token，向 registry 的
   `/-/npm/v1/oidc/token/exchange/package/<pkg>` 换取**一次性的发布 token**；
   也可通过 `NPM_ID_TOKEN` 传给 pnpm（pnpm 会校验其 `aud` 是否匹配目标 registry）。
3. npm 侧校验 OIDC claims（仓库、工作流文件名、可选 environment）与包的
   trusted publisher 配置一致，然后接受发布。
4. 因为 token 是短时的、且绑定到具体工作流，长期 `NPM_TOKEN` 不再需要，泄露风险消失。
5. provenance 由 pnpm 在 trusted publishing 下自动生成（Sigstore，要求公开仓库）；
   可用 `--no-provenance` 关闭（例如 self-hosted runner）。

> pnpm 版本要求：本仓库 CI 固定 `pnpm@12.16.1`；OIDC 发布支持更早的 pnpm 12 版本，
> 但建议保持 12.12+（该版本起 `pnpm dist-tag` 也支持 OIDC，可用于在 CI 里管理 dist-tag）。

## 版本与 dist-tag 策略

- 稳定版：默认 `latest`（`pnpm release:publish` / CI 已带 `--tag latest`）。
- 试验版：加 `--tag next`，例如 `pnpm publish -r --access public --no-git-checks --tag next`；
  用户安装时需要显式指定版本（DSH 插件市场按版本安装，不受 dist-tag 影响）。
- `engines.dsh` 当前为 `>=0.2.2-rc.1 <0.3.0`，**所有插件 / bundle 包都声明**；
  DSH 升级到 0.3 时需更新该范围并回归。
- 破坏性变更：遵循 semver；预发布版本请使用 `-rc.N` / `-alpha.N` 后缀。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| CI 报 `ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS` | 工作流缺少 `permissions: id-token: write`（或 job 级权限覆盖了它） |
| CI 报 401/403 / `no trust evidence` / `package not found` | trusted publisher 配置与本次运行不匹配：核对 repo、**工作流文件名**、environment 三项；或该包尚未配置/尚未首次发布 |
| `npm trust` 报 401/ENEEDAUTH | 未 `npm login`；OIDC 只用于 CI 发布，配置 trust 仍需要登录凭据 |
| `npm trust` 报 2FA / 权限错误 | 账号未开启 2FA，或使用了 "bypass 2FA" 的 Granular Token（不支持）；改用网页或交互登录 |
| `npm trust` 报 package 不存在 | 先手动发布一次该包（见"前置条件 1"），再配置 trusted publisher |
| `Cannot publish over the previously published versions` | 版本已存在，不能覆盖；必须升版本（或换 dist-tag 发布新版本） |
| CI 报 `tag v… expects version …, but: …` | `v*` tag 与包 `version` 不一致；把 6 个包 + 根 `package.json` 统一升到 tag 的版本后重推 tag |
| 部分包发布失败 | `pnpm publish -r` 会逐个发布；已成功的包会保留。修复后只补发失败包：`pnpm --filter <失败包> publish --access public --no-git-checks`，或整体升 patch 版本 |
| provenance 未生成 / 报 provenance 错误 | 仓库非公开、runner 非 GitHub-hosted、或使用了 `--no-provenance`；公开仓库 + hosted runner 应自动生成 |
| 误发版本 | npm 允许 72 小时内 `npm unpublish <pkg>@<version>`；超过则只能废弃（deprecate）并升版本 |
| 想改用新工作流文件名/环境 | 一个包只能存在一个 trust 配置：先 `npm trust list` + `npm trust revoke --id`，再重新配置（最多 10 个配置/包） |

## 发布后的用户安装方式

```sh
# CLI
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-devlead-bundle
```

本地 checkout 开发仍可用 `pnpm install:profile`（见主 [README](../README.md)）。

## 参考

- npm 文档：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- `npm trust` 命令：`npm help trust` / [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- pnpm：`pnpm help publish`，[pnpm publish 文档](https://pnpm.io/cli/publish)
- OpenSSF [Trusted Publishers](https://repos.openssf.org/trusted-publishers) 标准
