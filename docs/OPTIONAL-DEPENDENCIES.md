# 可选插件硬依赖审计：DevLead 套件 × DSH 0.2.2-rc.1

本文件回答一个问题：**DevLead 套件是否硬依赖任何可选插件**——包括第三方插件，以及 DSH
内置但默认关闭的实验性插件（worktree / forge / agent-team / session-titles / inspector /
plugin-market 等）。审计对象是本仓库的 6 个包（`protocol`、`devlead`、`tool`、`command`、
`client-ui`、`bundle`），审计基准是**已安装的 DeepSeek Harness `0.2.2-rc.1`** 及其官方
源码 tag `dsh-v0.2.2-rc.1`。

> 快照说明：本仓库行号取 2026-11-09 14:50 工作树快照。并行开发会移动行号，引用时请以
> 「文件 + 符号/上下文」为准。本审计只读仓库源码与安装运行时，未改动任何实现文件；
> `~/.dsh` 未被修改（见 §7.1 的前后校验）。其后的打磨轮次（0.1.1）与 **0.2.0** 修改了实现、
> 测试与 E2E：0.2.0 新增 cold lead 索引重建（`sessionQuery` + `sessionProjectionCache` 可选
> 探测，仍然零声明）、`/devlead reset` 持久记录、`useWorkspace(agent, request)` 与
> `wakeColdSession` 默认 `true`；E2E 扩为多阶段（阶段 1b 重启验证冷 lead 索引重建；阶段 2
> 在一次性 profile 里显式追加官方实验 forge bundle 以验证 worktree happy path，这不是产品
> 依赖）。最新验证计数见 §7.6。

## 1. 结论摘要

**没有发现任何真硬依赖：套件不硬依赖第三方插件，也不硬依赖任何实验性/默认关闭插件。**
因此**没有修改任何 `packages/*/package.json`，也没有需要的最小修复**。

| 依赖面 | 判定 | 关键证据（详见 §3–§6） |
| --- | --- | --- |
| 主机侧必需 `inject`：`agents` / `sessions` / `sessionProjections` / `tools` / `systemPrompt` / `commands` | 全部由**默认组合** `dsh-base` 的行提供 | `DSH:packages/bundle/base/cordis.patch.yml:82,40,172,498,510,321` |
| 主机侧运行期值导入：`cordis` / `schemastery` / `zod` / `dsh-session` / `dsh-llm` / `dsh-tools` / `dsh-commands` | 全部由**默认组合**提供（base 行或安装运行时库） | E1 安装运行时含 `cordis 4.1.0`、`schemastery 3.19.0`、`zod 4.4.3`；base 行见 §4.2 |
| 浏览器侧 `dsh.client.inject`（8 项） | 7 项是 `dsh-web-app` 默认客户端行，1 项（primitives）是 Web 壳的**平台单例**；全部默认提供 | `DSH:packages/bundle/web-app/cordis.patch.yml:117,244,253,265,268,322,366`；`DSH:packages/client/web/src/platform.ts:8-17` |
| 浏览器侧必需 cordis 服务：`slots` / `sessions` / `remote` / `remote.commands` / `locale` | 全部由默认组合的客户端插件提供 | §5.2 |
| 实验性 Git worktree 服务（`ctx.worktrees`） | **零依赖**：不 import、不进 `inject`、不进 `package.json`；仅 `ctx.get('worktrees')` 可选探测 | `packages/devlead/src/isolation.ts`（`worktreeCapabilityOf`）；`packages/devlead/tests/isolation.spec.ts`（`experimental dependency surface`） |
| agent-team / forge / session-titles / inspector / plugin-market | 代码、清单、脚本中**零引用**（仅测试里三条"必须不包含"的反向断言：源码扫描 / manifest / bundle patch） | §7.5；`DSH:packages/util/official-bundles/src/bundles.ts:55-70` |
| 第三方插件 | **零个** | 全仓依赖清单（§4.2/§4.3） |

一句话口径：**本套件面向「默认 Web 组合」= `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
构建**；该组合之外的实验性能力一律通过可选服务探测借用，缺失即退化，而不是加载失败。

运行证据（本轮工作树，由 Lead 执行）：在一次性 `DSH_HOME` + `--from-default-profile web`
生成的默认 Web 组合上，`node scripts/e2e-smoke.mjs --no-build --flow patch` 与
`--flow installed` 均 **61/61**（0.2.0 起多阶段：阶段 1 的默认组合断言、阶段 1b 的重启冷
lead 索引重建断言、阶段 2 的 experimental forge 组合断言），阶段 1 包含断言
`default profile reports no optional worktree isolation` → `Worktree isolation: unavailable`，
以及 summary 不携带 digest 的 `devLeadMode` 行；阶段 2 是**同一脚本在一次性 scratch profile
里显式追加官方实验 bundle** 验证 worktree happy path，用于证明「可选能力一旦组合就能工作」，
不构成产品对实验包的任何声明/依赖；
`pnpm build` 与 `node scripts/check-packages.mjs`（`OK (6 packages)`）同样通过。即
「无实验性 bundle 的默认 profile 可构建、可安装、可启动、可运行」在本工作树已有真实端到端
证据，而非计划（详见 §7.4）。

## 2. 判定口径与证据来源

### 2.1 什么算「硬依赖」

本审计把下列任一形态判为硬依赖（H），其余为软依赖（S）或平台事实（P）：

- **H1 必需 `inject`**：出现在插件的 `static inject` / `export const inject` 数组里。服务缺失
  时 Cordis 让条目保持 pending，插件不激活。
- **H2 运行期值导入**：`import { x } from 'pkg'`（非 `import type`）在模块顶层；模块加载即失败。
- **H3 必需 peer / 直接 import 的包**：`peerDependencies` 未标 `optional`，且该包只由非默认
  组合提供。
- **H4 文档/脚本/测试承诺**：README/DESIGN/E2E/构建脚本假设某可选能力默认存在（会把"缺失即
  退化"错误地变成"缺失即失败"）。

「硬依赖」本身不是问题——问题在于**被依赖对象是否属于默认组合**。本套件的所有 H 形态依赖
对象都在默认组合内（详见 §4），因此不构成对可选插件的硬依赖。

### 2.2 证据来源（E1–E6）

| 编号 | 证据 | 采集方式 |
| --- | --- | --- |
| E1 | 已安装运行时 `app.asar`（v0.2.2-rc.1）：22,105 个条目、332 个 `@deepseek-ai/*` 包，含 `zod@4.4.3`、`@deepseek-ai/schemastery@3.19.0`、`@deepseek-ai/cordis@4.1.0`、`dsh-base`/`dsh-web-app` 及全部实验包 | 解析 asar header 后按偏移读取 `package.json`（`dataBase = 8 + headerSize`，用条目 SHA-256 校验偏移，见 §10） |
| E2 | DSH 官方源码 **tag `dsh-v0.2.2-rc.1`（commit 66491b05e3）**：组合 patch 文件、入口语义、服务定义 | `git show dsh-v0.2.2-rc.1:<path>`。`dsh-base`/`dsh-web-app` 的 `cordis.patch.yml` 与 E1 安装包内文件**逐字节一致**（`package.json` 仅 `workspace:*` 被发布归一化为版本号） |
| E3 | 默认组合的**运行时 dump**：在临时 `DSH_HOME` 用 `--from-default-profile web --dump-config` 生成的组合树 | §7.1 的可复现命令；291 个 `@deepseek-ai/*` 名字行，0 个实验/可选 bundle 包，`~/.dsh` 未改 |
| E4 | 仓库单元测试：真实 cordis `Context` + 真实 `SessionStore`/`SessionProjectionRegistry`，可选服务用内存 fake，实验性服务缺席 | `packages/devlead/tests/harness.ts`（`bootService`）；`packages/devlead/tests/service.spec.ts`、`isolation.spec.ts` |
| E5 | `scripts/e2e-smoke.mjs`：一次性 profile 走默认 Web 组合并在真实 Web 运行时上做产品断言。**0.2.0 起多阶段：阶段 1（默认组合）+ 阶段 1b（同一加载流/scratch home 重启，验证冷 lead 索引重建）+ 阶段 2（一次性 scratch profile 显式追加官方实验 forge bundle、验证 worktree happy path），每条加载流 61/61**（含默认 profile 无 worktree 隔离、summary 不携带 `devLead` digest 的断言；`--no-worktree` 跳过阶段 2 = 39/39） | `scripts/e2e-smoke.mjs`（`runChecks()` / `runRehydrationChecks()` / `runWorktreeChecks()`、`enableWorktreeBundle()`、`linkProbePackage()`；probe 为私有测试包 `scripts/e2e-probe/**`，不进入 workspace/build/check-packages） |
| E6 | 打包不变式检查：host 运行期 `@deepseek-ai/*` 导入必须是 peer、DSH 包不得作为直接/optional 依赖、不得声明实验包、浏览器 `@deepseek-ai/*` 导入必须落在 module table、`dsh.client.inject` 与 root devDeps / module table 一致 | `scripts/check-packages.mjs`（import scan / dependency placement / client inject 三组检查）；本次运行 `node scripts/check-packages.mjs` → `OK (6 packages)` |
| E7 | **0.2.0 冷重建就绪证据**：E2E 阶段 1b 在真实 Host 重启后暴露了 `sessionQuery` 已定义但持久语料仍 live-only 的竞态；最终实现为有界 corpus-readiness barrier（`packages/devlead/src/persistence.ts` 的只读探针 + `awaitCorpusReady`），单元测试与 E2E 阶段 1b 双重覆盖 | `docs/DESIGN.md` §4.1.1；`packages/devlead/tests/service.spec.ts`（cold lead rehydration 用例组）；`scripts/e2e-smoke.mjs` 阶段 1b |

> ⚠️ **源码 checkout 的陷阱（重要）**：本机 DSH 源码 checkout 的 HEAD 是
> `fcc0ad46`，`git describe` = `dsh-v0.2.2-rc.1-811-gfcc0ad46`——它是
> *"把 release/dsh-0.2.2 合回 master"* 的 merge commit，比 rc.1 tag **晚 811 个提交**。
> 相对 tag，HEAD 的 `dsh-base` patch 已新增 post-rc.1 的 `agent-team` 行，客户端
> `boot-client.ts` 已改成「只有 required 白名单致命、其余 entry 仅警告」。**这些都不是
> 0.2.2-rc.1 的行为**。本文所有 DSH 证据一律以 tag `dsh-v0.2.2-rc.1` 为准，并已在 E1
> 安装包上复核；引用 HEAD 行号会得出错误结论。

### 2.3 审计范围与切分

- 计入：根 `package.json` 的 `devDependencies`、6 个包的 `dependencies`/`peerDependencies`/
  `peerDependenciesMeta`、`dsh.client.inject`、bundle 的 `cordis.patch.yml`、全部 `inject`
  导出、全部 `ctx.get(...)`/`ctx.<service>` 访问、全部 `@deepseek-ai/*` 与第三方 bare import、
  `scripts/e2e-smoke.mjs` 的 profile/bundle 假设、README/DESIGN 的能力承诺。
- 不计入：`@yankeguo/*` 工作区内部包（这是本套件自身分层，非可选插件，见 §4.4）。
- 不计入：devDependencies 中的构建/测试工具（esbuild、typescript、vitest、`@types/*`）。

## 3. 0.2.2-rc.1 的默认组合事实

### 3.1 出厂 profile 模板

`DSH:packages/util/official-bundles/src/bundles.ts:10-29` 的 `PROFILE_TEMPLATES`：

| 模板 | 组合 |
| --- | --- |
| `web` | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`（`:14-15`） |
| `acp` | `dsh-base` + `dsh-acp-app` |
| `headless` | `dsh-base` + `dsh-headless` |
| `sdk` | `dsh-base` + `dsh-sdk-app` |
| `sdk-minimal` | 仅 `dsh-sdk-minimal` |

本机真实 profile 也印证：`~/.dsh/profiles/web/package.json` 的
`dsh.profile.bundles` 就是 `[dsh-base, dsh-web-app]`，`dependencies: {}`。注意
`~/.dsh/profiles/desktop` 是**用户自建 profile**（出厂模板列表里没有 `desktop`，CLI 对
`--from-default-profile desktop` 会报未知模板），它额外显式启用了多个实验 bundle——那属于
用户自选组合，不属于默认组合。Lead 独立复核（`dsh probe --from-default-profile web
--dump-config`）：默认组合树中 `worktree`/`forge` 匹配数为 0。

### 3.2 `dsh-base` 默认提供的主机服务（本套件必需的那部分）

| 服务 | 提供包 | base patch 行 | 本套件使用方式 |
| --- | --- | --- | --- |
| `agents` | `@deepseek-ai/dsh-agent` | `:82` | devlead 必需 inject |
| `sessions` | `@deepseek-ai/dsh-session` | `:40` | devlead 必需 inject（`flush`/`list`/`get`/`create`） |
| `sessionProjections` | `@deepseek-ai/dsh-session-projection` | `:172` | devlead 必需 inject |
| `tools` | `@deepseek-ai/dsh-tools` | `:498` | tool 必需 inject |
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `:510` | tool 必需 inject |
| `commands` | `@deepseek-ai/dsh-commands` | `:321` | command 必需 inject |
| `llm` | `@deepseek-ai/dsh-llm` | `:34` | devlead 运行期值导入（消息构造） |
| `sessionTitle` | `@deepseek-ai/dsh-session-title` | `:60` | devlead **可选** `ctx.get` |
| `sessionQuery` | `@deepseek-ai/dsh-session-query-sqlite` 行（底层是 `dsh-session-query` 库；base 组合里以 `:memory:` + `openAt: never` 挂载） | `:157`，注释 `:149-156` 明确「仍然挂载 `ctx.sessionQuery`，精确读/标题/血缘可用」 | devlead **可选** `ctx.get` |
| `remote`（浏览器侧） | `@deepseek-ai/dsh-api-gateway` 的 client 半边（base 以 `typert-gateway` 行挂载该双面包） | base `:52`；client 半边 `super(ctx, 'remote')` 见 `DSH:packages/api/gateway/src/client/index.ts:155` | client-ui 必需 inject |

### 3.3 `dsh-web-app` 默认提供的主机/浏览器行（本套件用到的那部分）

| 服务/行 | 提供包 | web-app patch 行 | 本套件使用方式 |
| --- | --- | --- | --- |
| `workspaceRegistry` | `@deepseek-ai/dsh-workspace` | `:87` | devlead **可选** `ctx.get` |
| `sessionController` | `@deepseek-ai/dsh-api-session-controller` | `:117` | devlead **可选** `ctx.get` |
| 客户端行 `api-remotes`（挂载 `remote.commands` 命名空间） | `@deepseek-ai/dsh-api-remotes` | `:244` | client-ui `dsh.client.inject` + 必需服务 `remote.commands` |
| 客户端行 `locale`（提供 `ctx.locale`） | `@deepseek-ai/dsh-client-locale` | `:253` | 必需服务 `locale` |
| 客户端行 `ui-renderer`（提供 `ctx.slots`） | `@deepseek-ai/dsh-client-ui-renderer` | `:265` | 必需服务 `slots` |
| 客户端行 `ui-session`（提供 `ctx.sessions`） | `@deepseek-ai/dsh-client-ui-session` | `:268` | 必需服务 `sessions` |
| 客户端行 `ui-conversation` | `@deepseek-ai/dsh-client-ui-conversation` | `:322` | `dsh.client.inject` 项（slot 提供者） |
| 客户端行 `ui-workspace` | `@deepseek-ai/dsh-client-ui-workspace` | `:366` | `dsh.client.inject` 项 + type-only 槽位声明 |
| `modules` / `connection`（Web 客户端加载器与传输） | `@deepseek-ai/dsh-client-modules` / `dsh-client-connection` | `:223` / `:230` | Web 客户端运行的前提行（默认组合提供） |

### 3.4 浏览器平台单例（不是 profile 行，永远由 Web 壳提供）

Web 壳在 Cordis 启动前就把以下模块放进冻结 module table：
`DSH:packages/client/web/src/platform.ts:8-17`（`PLATFORM_MODULES`）与
`DSH:packages/client/web/src/seed.ts:9-18,26-41`（静态 import → `getStaticModules()`）：

```
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
@tanstack/react-virtual, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

这些模块**不依赖任何 profile 组合**：即使某个（非默认）profile 不挂载对应插件行，它们仍在
module table 里。E1 佐证：安装运行时 `dsh/node_modules/@deepseek-ai/` 下**没有**
`dsh-client-ui-primitives` / `dsh-client-ui-slots`（它们被编进 Web 前端产物
`dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`，可在其中检索到
`IconUsersOutlineRegular` 等符号）。

### 3.5 实验性/默认关闭的 bundle（全部不在默认组合中）

`DSH:packages/util/official-bundles/src/bundles.ts:55-70` 的 `OPTIONAL_BUNDLES`
（插件管理器里默认关闭、"官方可选"）在 rc.1 包含：

| bundle | rc.1 中的组合效果 | 是否默认组合 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-tool-worktree` | 插入 `worktree` + `tool-worktree` 两行（`DSH:packages/experimental/tool-worktree/cordis.patch.yml:1-5`），提供 `ctx.worktrees` | 否 |
| `@deepseek-ai/dsh-experimental-forge-bundle` | 插入 worktree/tool-worktree/forge/forge-github/forge-session + forge 面板组（`DSH:packages/experimental/forge-bundle/cordis.patch.yml:1-8`） | 否 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 替换 subagent 工具为 team 工具 + `agent-team`/`tool-agent-team`/`ui-agent-team` | 否（rc.1 仍在可选清单 `:62`；master 才把它列入 retired） |
| `@deepseek-ai/dsh-experimental-session-titles-bundle` | **替换标题刷新插件**：禁用 base 的 `session-title-llm`，插入 `session-title-all-prompts-llm`（`DSH:packages/experimental/session-titles-bundle/cordis.patch.yml:1-8`） | 否；注意 `ctx.sessionTitle` **服务本身是 base 默认行**（`base:60`） |
| `@deepseek-ai/dsh-experimental-inspector-profile` / `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 面板/市场页面 | 否（`:66` / `:68`） |

### 3.6 「安装包里有该包」≠「组合里启用了该服务」

这是本审计最容易误判的一点。E1 显示安装运行时物理上包含**全部**实验包
（`dsh-experimental-worktree`、`dsh-experimental-forge`、`dsh-experimental-agent-team`、
`dsh-experimental-session-titles-bundle`、`dsh-experimental-inspector-profile`、
`dsh-experimental-plugin-market-bundle` 等都在 `app.asar` 的 `dsh/node_modules/` 里），
但它们**不被默认 profile 选中**，因此其服务（如 `ctx.worktrees`）在默认 Host 上**不存在**。
判定必须以「组合后服务是否可用」为准，而不是「npm 包是否安装」。

## 4. 依赖判定表（逐包）

### 4.1 读法

- 「类别」：**默认组合**（base/web-app 行或平台单例/运行时库）/ **实验性默认关闭** /
  **第三方库**（平台/运行时提供）/ **内部包** / **仅开发**。
- 「硬依赖?」：本仓库是否以 H1–H4 形态依赖它。对默认组合的硬依赖是**平台契约**，不是风险；
  风险只发生在「硬依赖 + 对象非默认」——本表该组合为 **0 行**。
- 「缺失时行为」：默认组合下不会发生；列出是为了说明契约边界（也用于 §6 的退化论证）。

### 4.2 主机侧（Host）

| 包 | 类别 | 本仓库引入形态 | 硬依赖? | 缺失时行为 | 证据（本仓库；DSH rc.1 / E1） | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/cordis` | 默认组合（DSH 运行时核心库 + 浏览器平台单例） | 各包 peer；host 值导入 `Service`；浏览器 type-only | 是（平台核心，非插件） | host 模块加载失败 | `packages/devlead/package.json:16`、`tool`:16、`command`:16、`client-ui`:34、`bundle`:30；根 `package.json:27`；E1 `cordis 4.1.0` | 保持 |
| `@deepseek-ai/schemastery` | 默认组合（安装运行时库；DSH 设置组件依赖它） | devlead/tool peer；devlead 值导入（Loader `Config` schema） | 是（库，非插件） | 模块加载失败 | `devlead/package.json:25`、`tool`:22；E1 `3.19.0`；`DSH:packages/settings/settings/package.json:40` | 保持 |
| `zod` | 第三方库，但**由安装运行时 + 浏览器平台提供** | devlead peer + 根 devDep；devlead 值导入（严格记录 schema） | 是（库，非插件） | 模块加载失败 | `devlead/package.json:26`；根 `package.json:54`；E1 `4.4.3`；`DSH:packages/session/session-projection/package.json:37`（base 依赖链内）；`DSH:platform.ts:10` | 保持 |
| `@deepseek-ai/dsh-session` | 默认组合（base:40） | peer；值导入 `appendPluginRecord`/`SessionId`；必需 inject `sessions` | 是（默认服务） | 条目 pending；Host 启动仅告警（见 §6.2） | `devlead/package.json:20`、`:230`；`DSH:base:40` | 保持 |
| `@deepseek-ai/dsh-llm` | 默认组合（base:34） | peer；值导入 `createUserMessage`/`HarnessError` | 是 | 同上 | `devlead/package.json:19`、`tool`:18；`DSH:base:34` | 保持 |
| `@deepseek-ai/dsh-session-projection` | 默认组合（base:172） | peer；type-only；必需 inject `sessionProjections` | 是 | 同上 | `devlead/package.json:21`、`:230`；`protocol/package.json:21`（type-only，optional）；`DSH:base:172` | 保持 |
| `@deepseek-ai/dsh-agent` | 默认组合（base:82） | peer；type-only；必需 inject `agents` | 是 | 同上 | `devlead/package.json:17`、`tool`:17；`DSH:base:82` | 保持 |
| `@deepseek-ai/dsh-tools` | 默认组合（base:498） | tool peer；值导入 `defineTool`；必需 inject `tools` | 是 | 同上 | `tool/package.json:21`、`:62`；`DSH:base:498` | 保持 |
| `@deepseek-ai/dsh-system-prompt` | 默认组合（base:510） | tool peer；type-only；必需 inject `systemPrompt` | 是 | 同上 | `tool/package.json:20`、`:62`；`DSH:base:510` | 保持 |
| `@deepseek-ai/dsh-commands` | 默认组合（base:321） | command peer；值导入（含 `dsh-commands/brand`）；必需 inject `commands` | 是 | 同上 | `command/package.json:17`、`:34`；`DSH:base:321` | 保持 |
| `@deepseek-ai/dsh-session-title` | 默认组合（base:60） | devlead peer（**optional**）；type-only；`ctx.get` 可选 | **否**（使用可选；服务默认提供） | 标题字段省略、rename 跳过并 warn | `devlead/package.json:23`、meta`:35-37`；`src/index.ts:845`、`src/views.ts:179`、`src/notification.ts:352`；`DSH:base:60` | 保持；optional 标注为防御性 |
| `@deepseek-ai/dsh-session-query` | 默认组合（base:157，注释 `:149-156` 明示仍挂载 `ctx.sessionQuery`） | devlead peer（**optional**）；type-only；`ctx.get` 可选 | **否** | 冷会话/批量标题读降级，live 行保留 | `devlead/package.json:22`、meta`:32-34`；`src/views.ts:140,184,302,474`；`DSH:base:149-160` | 保持；optional 标注为防御性 |
| `@deepseek-ai/dsh-api-session-controller` | 默认组合仅 Web（web-app:117；headless/acp/sdk 不挂） | devlead peer（**optional**）；type-only；`ctx.get` 可选；client `inject` 边 | **否** | 创建/冷恢复报 `DEVLEAD_SESSION_UNAVAILABLE` | `devlead/package.json:18`、meta`:29-31`；`src/index.ts:505-512,589,896`；`DSH:web-app:117` | 保持 |
| `@deepseek-ai/dsh-workspace` | 默认组合仅 Web（web-app:87；headless/acp 无，sdk-app 有 registry 无 controller） | devlead peer（**optional**）；type-only；`ctx.get` 可选 | **否** | Workspace 操作报 `DEVLEAD_WORKSPACE_NOT_FOUND`，列表降级 | `devlead/package.json:24`、meta`:38-40`；`src/index.ts:342,713,857`、`src/views.ts:134,220,430`；`DSH:web-app:87` | 保持 |

### 4.3 浏览器侧（Client）

| 包 | 类别 | 本仓库引入形态 | 硬依赖? | 缺失时行为 | 证据 | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| `react`（含 `react/jsx-runtime`） | 第三方库，**浏览器平台单例**（壳内打包，profile 无关） | 根 devDep；client 值导入 hooks/JSX；构建 external | 是（平台单例） | 浏览器 bundle 无法 require（壳不可能缺） | 根 `package.json:51`；`scripts/client-externals.mjs:13-24`；`DSH:platform.ts:9`；`DSH:seed.ts:9,31` | 保持（devDep 足够） |
| `@deepseek-ai/dsh-client-ui-slots` | 平台单例（**不是** profile 行） | 根 devDep；浏览器 type-only（SlotMap 类型） | 否 | 无（仅类型/槽位契约） | 根 `package.json:36`；`DSH:platform.ts:12`；`DSH:seed.ts:39`；E1 无该 host 包 | 保持 |
| `@deepseek-ai/dsh-client-ui-primitives` | 平台单例（**不是** profile 行） | 根 devDep；client 值导入（Button/Switch/Tooltip/图标） | 是（平台单例，壳保证） | 浏览器 bundle 无法 require（壳不可能缺） | 根 `package.json:33`；`DSH:platform.ts:13`；`DSH:seed.ts:40`；E1 前端产物内联 | 保持 |
| `@deepseek-ai/dsh-api-remotes` | 默认组合（web-app:244） | client `dsh.client.inject` id；浏览器 type-only | 否（informational 边）；其 client 半边提供 `remote.commands` | 若连行都缺失：client 条目 pending（§5） | `client-ui/package.json:21`；根 `package.json:29`；`DSH:web-app:244`；`DSH:packages/api/remotes/src/client/index.ts:192` | 保持 |
| `@deepseek-ai/dsh-api-session-controller` | 默认组合 Web（web-app:117） | client `dsh.client.inject` id；浏览器 type-only | 否；其 client 半边提供 `sessions` | 同上 | `client-ui/package.json:22`；`DSH:web-app:117` | 保持 |
| `@deepseek-ai/dsh-client-locale` | 默认组合（web-app:253） | client `dsh.client.inject` id；浏览器 type-only | 否；提供 `locale` | 同上 | `client-ui/package.json:23`；`DSH:web-app:253`；`DSH:packages/client/locale/src/client/index.ts:588` | 保持 |
| `@deepseek-ai/dsh-client-ui-conversation` | 默认组合（web-app:322） | client `dsh.client.inject` id；浏览器 type-only | 否（slot 声明者） | 该插槽不渲染；页面**不会**因此失败（无服务注入要求） | `client-ui/package.json:24`；`DSH:web-app:322` | 保持 |
| `@deepseek-ai/dsh-client-ui-renderer` | 默认组合（web-app:265） | client `dsh.client.inject` id；浏览器 type-only | 否；提供 `slots` | 条目 pending（§5） | `client-ui/package.json:26`；`DSH:web-app:265`；`DSH:packages/client/ui-renderer/src/client/registry.ts:160` | 保持 |
| `@deepseek-ai/dsh-client-ui-session` | 默认组合（web-app:268） | client `dsh.client.inject` id；浏览器 type-only | 否 | 同上 | `client-ui/package.json:27`；`DSH:web-app:268` | 保持 |
| `@deepseek-ai/dsh-client-ui-workspace` | 默认组合（web-app:366） | client `dsh.client.inject` id；浏览器 type-only（Session 行槽位） | 否 | sidebar 行 seat 不渲染 | `client-ui/package.json:28`；`DSH:web-app:366`；`docs/DESIGN.md:412-416` | 保持 |
| `@deepseek-ai/dsh-api-gateway` | 默认组合（base 行 `typert-gateway`:52；其 client 半边提供 `ctx.remote`） | **未直接声明**；由 client-ui 的必需服务 `remote` 间接依赖 | 否（无直接 import/peer） | — | `DSH:base:52`；`DSH:packages/api/gateway/src/client/index.ts:155`；E1 该包 `dsh.client.platform: web` | 不新增声明（非直接依赖） |

### 4.4 内部包与仅开发依赖（排除项）

| 项 | 说明 | 证据 |
| --- | --- | --- |
| `@yankeguo/dsh-devlead-protocol` / `dsh-devlead` / `dsh-tool-devlead` / `dsh-command-devlead` / `dsh-client-ui-devlead` / bundle | 本套件自身的分层依赖（`workspace:*`），不是可选插件 | `packages/bundle/package.json:23-28`；`docs/DESIGN.md:46` |
| `esbuild` / `typescript` / `vitest` / `@types/node` / `@types/react` | 仅构建/类型检查/测试工具链，不进入运行时 | 根 `package.json:48-54`；`scripts/check-packages.mjs`（`DEV_INFRA`） |

### 4.5 判定表小结

- 本仓库引用到的 `@deepseek-ai/*` 共 **21 个**（host 侧 13 个；浏览器/类型侧新增 9 个，
  其中 `dsh-api-session-controller` 与 host 侧重合、`dsh-client-ui-slots` 仅 type-only），
  **全部属于默认组合或平台单例**；
- 其中以 **H 形态**（必需 inject / 运行期值导入 / 必需 peer）依赖的 `@deepseek-ai/*` 有 9 个
  （cordis、schemastery、dsh-agent、dsh-session、dsh-session-projection、dsh-llm、dsh-tools、
  dsh-system-prompt、dsh-commands），外加第三方库 zod，全部由 `dsh-base` 或安装运行时提供；
- 以 **S 形态**（可选 `ctx.get` / optional peer）探测的能力共 7 个：package 级 optional peer 4 个
  （workspace、session-controller、session-title、session-query；前两个仅 Web 默认提供，后两个
  base 默认提供），零声明仅探测的服务 3 个（worktrees 属实验性默认关闭；0.2.0 新增
  `sessionProjectionCache` 与 `sessionPersistence`，都来自 base 默认行，见 §6.1）；
- 引用到的第三方库 2 个（`zod`、`react`），均由平台提供；实验性插件 **0 个**，第三方插件
  **0 个**。

## 5. 客户端半边：`dsh.client.inject` 逐项核验

### 5.1 逐项核验

`packages/client-ui/package.json:17-31` 声明 `dsh.client.platform: "web"` 与 8 个
`dsh.client.inject` id。逐项对照默认 Web 组合：

| id | 类别 | 默认组合证据 | E1 中作为 host 包存在？ | 本仓库 import 形态 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-api-remotes` | web-app 客户端行 | `DSH:web-app:244` | 是 | type-only |
| `@deepseek-ai/dsh-api-session-controller` | web-app 客户端行 | `DSH:web-app:117` | 是 | type-only |
| `@deepseek-ai/dsh-client-locale` | web-app 客户端行 | `DSH:web-app:253` | 是 | type-only |
| `@deepseek-ai/dsh-client-ui-conversation` | web-app 客户端行 | `DSH:web-app:322` | 是 | type-only |
| `@deepseek-ai/dsh-client-ui-primitives` | **平台单例**（非行） | `DSH:platform.ts:13`、`seed.ts:18,40` | **否**（编进 Web 前端产物） | 值导入（module table） |
| `@deepseek-ai/dsh-client-ui-renderer` | web-app 客户端行 | `DSH:web-app:265` | 是 | type-only |
| `@deepseek-ai/dsh-client-ui-session` | web-app 客户端行 | `DSH:web-app:268` | 是 | type-only |
| `@deepseek-ai/dsh-client-ui-workspace` | web-app 客户端行 | `DSH:web-app:366` | 是 | type-only |

结论：**默认 Web 组合覆盖 7/8 的 profile 行，第 8 项是壳内平台单例，亦可保证。**

### 5.2 这些 id 在 rc.1 的 loader 语义

必须区分三层，混为一谈会得出错误的"硬依赖"结论：

1. **包级 `dsh.client.inject` = 信息性依赖（informational）**。Host 的 `client-modules`
   扫描每个 `dsh.client` 行时，把这些 id 原样填进 boot graph 的 `row.inject`，用于浏览器侧
   「工厂到位的先后」；它**不参与 Cordis 激活顺序**，也不校验目标行是否存在。
   `DSH:packages/client/ui-workspace/src/client/index.ts:96-101` 官方注释：
   *"dsh.client.inject edges are informational (loading/prefetch metadata, never apply
   sequencing)"*。
2. **目标行不存在时被静默跳过**。浏览器侧 `arriveGraphRow` 对 `row.inject` 里不在图里的
   id 直接跳过：`DSH:packages/client/modules/src/client/system.ts:275-277`
   （`const dependency = this.graphRows.get(packageName); if (dependency !== undefined) …`）。
   因此 `dsh.client.inject` 指向 `dsh-client-ui-primitives` 这类**平台单例名**不会报错、
   也不会等待（`docs/AUDIT.md` 遗留限制已有同样结论）。
3. **真正的激活要求是 client 模块导出的 Cordis `inject` 数组**：
   `packages/client-ui/src/client/index.tsx:56`
   `export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']`。
   服务缺失 → 该 Loader 条目 pending。**rc.1 的客户端启动审计是严格的**：任何非 active
   条目都会抛 `web boot: N entries did not activate`
   （`DSH:packages/client/web/src/boot-client.ts:66-87`）。该版本**没有** required 白名单
   ——本机安装的 Web 前端产物中可检索到 `web boot:` 与 `did not activate`，且不存在
   `requiredClientEntryNames` / `(required)` 标记。也就是说：在 rc.1 上，client-ui 缺任一
   必需服务不是"控件不渲染"，而是**整个 Web 页面启动失败**。

### 5.3 5 个必需客户端服务的提供者

| 服务 | 提供者（默认组合） | 默认组合证据 |
| --- | --- | --- |
| `slots` | `@deepseek-ai/dsh-client-ui-renderer` 的 client 半边 | `DSH:web-app:265`；`DSH:packages/client/ui-renderer/src/client/registry.ts:160` |
| `sessions` | `@deepseek-ai/dsh-api-session-controller` 的 client 半边 | `DSH:web-app:117`；`DSH:packages/api/session-controller/src/client/index.ts:93,98` |
| `remote` | `@deepseek-ai/dsh-api-gateway` 的 client 半边 | `DSH:base:52`（`typert-gateway` 行）；`DSH:packages/api/gateway/src/client/index.ts:155` |
| `remote.commands` | `@deepseek-ai/dsh-api-remotes` 的 client 半边挂载 `commandsRemote` | `DSH:web-app:244`；`DSH:packages/api/remotes/src/client/index.ts:192` |
| `locale` | `@deepseek-ai/dsh-client-locale` 的 client 半边 | `DSH:web-app:253`；`DSH:packages/client/locale/src/client/index.ts:588` |

5 个提供者全部来自默认 Web 组合，因此 **client 半边不构成对可选插件的硬依赖**。它构成的是
「对默认 Web 组合的硬依赖」——这正是本套件声明的目标平台（见 §9 R1 的残余风险）。

另外：`dsh.client.platform: "web"` 使该浏览器半边只在 Web/Desktop 这类带 Web 壳的组合中
被加载；headless/acp/sdk 不会加载它，因此不存在"在无 UI profile 里等待客户端服务"的问题。

## 6. 运行时退化路径（可选服务）

### 6.1 可选服务的使用与缺席行为

| 服务 | 使用点（本仓库） | 缺席时的行为 | 测试证据 |
| --- | --- | --- | --- |
| `workspaceRegistry` | `src/index.ts:342,713,857`；`src/views.ts:134,220,430`；`src/notification.ts:425` | 列表跳过 Workspace 维度；写操作抛 `DEVLEAD_WORKSPACE_NOT_FOUND`；归档判定按"未归档" | `packages/devlead/tests/service.spec.ts:543-560`（无 registry 时明确报码） |
| `sessionController` | `src/index.ts:505,589,896`；`src/notification.ts:499` | `createSession` 抛 `DEVLEAD_SESSION_UNAVAILABLE`；冷会话 prompt 同样报码；通知的冷唤醒静默跳过 | `service.spec.ts:1026-1028`、`:967-990`（无 controller / resolver 失败） |
| `sessionTitle` | `src/index.ts:845-855`；`src/views.ts:179`；`src/notification.ts:352` | 标题字段省略；`rename` 跳过并 warn（不使创建失败） | `tests/harness.ts:320-364`（fake 服务形状）；服务实际由 base 默认提供 |
| `sessionQuery` | `src/views.ts:140,184,302,474`；`src/index.ts`（`persistedLeadRecords` 冷扫描） | 冷会话/批量标题读降级，live Session 行仍可列出；无 query 时冷 lead 不重建索引 | `service.spec.ts:729-743`（query 引擎抛错时保留 live 行）、`service.spec.ts` 冷重建用例（无 query 只恢复 live） |
| `sessionProjectionCache`（0.2.0 新增探测） | `src/projection-cache.ts`（`projectionCacheOf` / `devLeadPrefilterOf`） | 冷重建退化为"只恢复 live lead"，并 warning 一次；冷扫描不读任何持久日志 | `service.spec.ts` 冷重建用例（`rehydrates only live leads when no projection cache is composed`） |
| `sessionPersistence`（0.2.0 新增探测，仅就绪判定） | `src/persistence.ts`（`persistedSessionsOf` 结构化探针）；`src/index.ts`（`awaitCorpusReady` / `armRehydrationRetry`） | 缺失时先 live-attach 回退并等待一次性 `ctx.inject` 重试；权威 cold scan 前 await corpus-readiness barrier（persistence 的完整存储 id 与 query 的 persisted 语料比对，100ms 轮询、有界 2s，超时 warning + best-effort），从未组合则冷扫描不执行（不 per-event 扫描） | `service.spec.ts` 冷重建用例（persistence 就绪前等待、stale corpus 等待、永不就绪时 live 仍可用、readiness 扫描一次、query engine 晚到、one-shot 保持 armed） |
| `worktrees`（实验） | `src/isolation.ts`（`worktreeCapabilityOf`；`ctx.get('worktrees')`）；`src/index.ts`（`worktreeIsolationAvailable` / `isolateSession`） | `isolation: {requested:'worktree', status:'unavailable'/'failed', reason?}`；创建与 prompt 照常（唯一例外是防御性的"子 Agent 非 live"：隔离报 `unavailable`，若同时要求 prompt 则仍走既有 `DEVLEAD_SESSION_UNAVAILABLE`；发行版 controller 不会触发） | `packages/devlead/tests/isolation.spec.ts`（缺失/非 live/失败/畸形服务/动态提供/取消） |

**0.2.0 新增的可选服务（cold lead 索引重建，零声明）**：只用
`ctx.get('sessionQuery')`、`ctx.get('sessionProjectionCache')`（结构化 `cachedSnapshot` 探测）
与 `ctx.get('sessionPersistence')`（`src/persistence.ts` 的结构化 `list()` 只读探针，用于
corpus-readiness barrier 的就绪判定）三个可选服务；三者都是 `dsh-base` 默认行，但 DevLead
不 import、不 `static inject`、不在 `package.json` 声明它们。缺失时的退化：无 query /
persistence → 不扫描持久语料、只恢复 live lead（且不 per-event 扫描）；无 projection cache
→ 冷扫描不读任何日志、只恢复 live lead 并 warning 一次。

### 6.2 必需 `inject` 逐项核验

| 包 | `inject` | 提供者 | 默认组合证据 | 缺失后果 |
| --- | --- | --- | --- | --- |
| `@yankeguo/dsh-devlead` | `['agents','sessions','sessionProjections']`（`src/index.ts:230`） | `dsh-agent` / `dsh-session` / `dsh-session-projection` | `DSH:base:82,40,172` | 条目 pending；Host 启动仅告警（这些行不在全局 required 列表，`DSH:packages/boot/app-boot/README.md:43`） |
| `@yankeguo/dsh-tool-devlead` | `['devLead','tools','systemPrompt']`（`src/index.ts:62`） | 自身 / `dsh-tools` / `dsh-system-prompt` | `DSH:base:498,510` | 同上 |
| `@yankeguo/dsh-command-devlead` | `['commands','devLead']`（`src/index.ts:34`） | `dsh-commands` / 自身 | `DSH:base:321` | 同上 |
| `@yankeguo/dsh-client-ui-devlead`（node 半边） | 无（空 `apply`，`src/index.ts:11-12`） | — | — | — |
| `@yankeguo/dsh-client-ui-devlead`（浏览器半边） | `['slots','sessions','remote','remote.commands','locale']`（`src/client/index.tsx:56`） | §5.3 的 5 个客户端插件 | §5.3 | 条目 pending；rc.1 下**Web 页面启动失败**（§5.2） |

**没有任何必需 `inject` 指向实验性/默认关闭服务。** 新的 optional worktree 隔离也没有破坏
这条基线：`packages/devlead/tests/isolation.spec.ts`（`experimental dependency surface`） 直接断言 `static inject` 仍是
`['agents','sessions','sessionProjections']`、且 `package.json` 不含 `dsh-experimental`。
0.2.0 的 cold 重建为等待 `sessionPersistence` 就绪使用了一次性 `ctx.inject(['sessionPersistence'], …)`
回调——这是 cordis 的**运行期可选服务 fiber**（未组合时永不触发、插件照常激活），不是
`static inject`，因此不改变 H1 判定，也没有新增依赖声明。

### 6.3 `peerDependenciesMeta` 逐项

| 包 | optional peer | 是否真可选 | 说明 |
| --- | --- | --- | --- |
| `devlead` | `dsh-api-session-controller`、`dsh-session-query`、`dsh-session-title`、`dsh-workspace`（`package.json:28-40`） | controller/workspace 是；title/query **实际由 base 默认提供**，标注 optional 属防御性冗余 | 让包在"非 Web/自定义组合 + 无类型检查 peer"时仍可安装；运行时由 `ctx.get` 兜底 |
| `protocol` | `dsh-session-projection`（`package.json:20-26`） | 是（且仅 `import type`，构建后被擦除） | 纯协议包不产生运行期依赖 |

### 6.4 headless / acp / sdk 组合下的行为（残余风险之一）

| profile | `workspaceRegistry` | `sessionController` | `sessionTitle` / `sessionQuery` | DevLead 表现 |
| --- | --- | --- | --- | --- |
| web（默认） | 有 | 有 | 有 | 全功能 |
| desktop | 有（桌面组合含 web-app） | 有 | 有 | 全功能 |
| headless | **无** | **无** | 有（base） | 可加载、模式/命令可用；dispatch（创建 Session / Workspace）报结构化错误 |
| acp | **无** | **无** | 有（base） | 同上 |
| sdk | 有（`DSH:packages/bundle/sdk-app/cordis.patch.yml:54-55`） | **无** | 有（base） | Workspace 管理可用；创建 Session 报码 |

证据：`DSH:packages/bundle/headless/cordis.patch.yml` 与 `acp-app/cordis.patch.yml` 均无
`dsh-workspace`/`dsh-api-workspace-controller` 行；sdk-app 只有 registry。该行为**是退化
而非崩溃**，且 README 已声明本套件面向默认 Web 组合。是否需要在文档中更醒目地标"仅
Web/Desktop 完整支持"，见 §9 R5。

### 6.5 新的可选 worktree 隔离（并行开发，已纳入审计）

本轮并行开发给 `devlead_create_session` 增加了 `isolation: "worktree"`。审计确认其依赖面
仍是**零硬依赖**：

- `packages/devlead/src/isolation.ts`（`worktreeCapabilityOf`）：`ctx.get('worktrees')` + 结构化 duck typing，
  只声明本地 `WorktreeCapability` 接口；**没有** import（连 type-only 都没有）任何
  `@deepseek-ai/dsh-experimental-*`。
- `packages/devlead/src/index.ts`（`worktreeIsolationAvailable` getter / `isolateSession` 调用点）：能力缺失时返回
  `unavailable`，创建与 prompt 继续。
- `packages/devlead/package.json` 未新增该实验包的任何 dependency/peer；
  `packages/devlead/tests/isolation.spec.ts`（`experimental dependency surface`） 用源码扫描断言"不得出现
  `@deepseek-ai/dsh-experimental`"、`inject` 不含该服务、`package.json` 不含
  `dsh-experimental`。
- 组合侧该服务只由默认关闭的可选 bundle 提供：
  `DSH:packages/experimental/tool-worktree/cordis.patch.yml:1-5`、
  `DSH:packages/experimental/forge-bundle/cordis.patch.yml:2`、
  服务名 `worktrees` 见 `DSH:packages/experimental/worktree/src/index.ts:61-79`。
- E2E 阶段 1 断言默认组合下 `Worktree isolation: unavailable` 且其余功能正常；**0.2.0 新增
  阶段 2**：同一脚本、同一 scratch root/profile，停实例 → 向 profile 的
  `dsh.profile.bundles` 追加官方 `@deepseek-ai/dsh-experimental-forge-bundle`（由安装版内置
  官方 inventory 解析，无需 pnpm install / 网络 / lockfile 变更）→ 把私有测试包
  `scripts/e2e-probe` 链接进 profile 的 `node_modules/@yankeguo/` 作为 linked root → 生成 probe
  patch 插入其插件行 → 用**同一加载流**重启 → 断言 `Worktree isolation: available` 与真实 Git
  worktree happy path（见 §7.4）。阶段 1b 用同一 scratch home 重启同一加载流验证冷 lead
  索引重建（D2 的端到端证据）。两条加载流各 **61/61**（27 + 12 + 22）；`--no-worktree` 跳过阶段 2
  （39/39）。probe 包 `@yankeguo/dsh-devlead-e2e-probe`（0.0.0）是私有测试资产，不发布、
  不进 workspace/build/check-packages。文档承诺见 README 的 Notification loop / Development
  and verification 与 `docs/DESIGN.md` §10（行号随并行开发漂移，引用按小节）。

## 7. 验证方式与证据

### 7.1 默认组合的活体证据（E3，本审计已执行）

在**临时 `DSH_HOME`** 里让真实 CLI 从出厂 web 模板创建一次性 profile 并 dump 组合
（不安装任何东西、不影响 `~/.dsh`）：

```sh
TMP=$(mktemp -d /tmp/devlead-optdep-audit-XXXXXX)
mkdir -p "$TMP/home"
cd "$TMP"
DSH_HOME="$TMP/home" dsh devlead-audit --from-default-profile web --dump-config > dump.yml
```

结果（本机 DSH `0.2.2-rc.1`，exit 0，stderr 为空）：

- `dump.yml` 共 1243 行，`name: '@deepseek-ai/...'` 行 **291** 个；
- 其中 `dsh-experimental*` / 可选 bundle 包 **0** 个（`grep -c` 结果为空）；
- 生成的 profile manifest：`dsh.profile.bundles = ["@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app"]`、`dependencies: {}`；
- `~/.dsh/profiles/web/package.json` 的 SHA-256 在命令前后一致（真实 `~/.dsh` 未被修改）。

该实验同时证明：§3.2–§3.3 表格里我们需要的**每一个**提供者行都确实出现在默认组合中
（`dsh-session`、`dsh-session-projection`、`dsh-session-title`、`dsh-session-query-sqlite`、
`dsh-tools`、`dsh-system-prompt`、`dsh-commands`、`dsh-agent`、`dsh-workspace`、
`dsh-api-session-controller`、`dsh-api-remotes`、`dsh-client-locale`、`dsh-client-ui-*` 等）。

### 7.2 安装运行时的包存在性（E1，本审计已执行）

解析 `app.asar`（22,105 条目）后按包名核对：

- `zod@4.4.3`、`@deepseek-ai/schemastery@3.19.0`、`@deepseek-ai/cordis@4.1.0`、
  `dsh-base@0.2.2-rc.1`、`dsh-web-app@0.2.2-rc.1` 全部存在；
- §4 表格中所有 host 包存在；`dsh-client-ui-primitives` / `dsh-client-ui-slots` **不作为
  host 包存在**（符合平台单例事实，编进 Web 前端产物）；
- 实验包（worktree/forge/agent-team/session-titles/inspector/plugin-market）**全部存在**，
  但默认组合不挂载（§3.6）。

### 7.3 单元测试证据（E4，阅读 + 现有测试套）

- `packages/devlead/tests/harness.ts`（`bootService`）：`bootService()` 用真实 cordis `Context`、
  真实 `SessionStore`/`SessionProjectionRegistry`，`workspaceRegistry` / `sessionController` /
  `sessionQuery` 只在传入时 `ctx.provide`；大量用例直接 `bootService()`（无任何可选服务）通过，
  证明核心服务在缺可选服务时仍能激活与工作。
- 退化路径断言：`service.spec.ts:543-560`（无 registry）、`:729-743`（query 失败保留 live 行）、
  `:967-990`、`:1026-1028`（无 controller 的明确错误码）。
- 可选 worktree：`isolation.spec.ts`（worktree 隔离用例组） 覆盖缺失/畸形/失败/动态提供/取消；
  `experimental dependency surface` 断源码与清单中无实验包引用、`inject` 不含实验服务。
- `tool` / `command` 测试完全不 boot DSH 运行时（`packages/tool/tests/harness.ts:282-303`、
  `packages/command/tests/fake.ts` 用结构化 fake），从测试侧确认它们只依赖注入的服务接口。

### 7.4 E2E 路径（E5，0.2.0 多阶段；patch / installed 各 61/61 通过）

`scripts/e2e-smoke.mjs` 的路线：

**阶段 1（默认组合）**

1. `createProfile()`：`dsh <scratch> --from-default-profile web --dump-config`，
   `DSH_HOME=临时目录` → 一次性 profile 只有 base+web-app；
2. `installProfile()` 或 `dev-patch` 流把套件装进该一次性 profile；
3. 启动真实 Web 运行时，用浏览器同款 HTTP API 断言；
4. boot graph 断言 client 条目及其 `dsh.client.inject`；
5. `session/list` summary 断言 `devLeadMode` 存在且 digest 级 `devLead` 不在 summary（侧栏
   标记的传输契约）；
6. `/devlead status` 断言 `Worktree isolation: unavailable`，证明默认组合不含实验 worktree
   bundle、可选能力缺席时套件照常工作。

**阶段 1b（冷 lead 索引重建）**

1. 停掉阶段 1 实例（**同一加载流、同一 scratch root、同一一次性 `DSH_HOME`**，从不同时跑两个
   实例），用同一 `--patch`/installed 加载方式重启；
2. 冷 lead（没有 live Agent、只有持久日志）读取 `devLead` projection：仍是 enabled、仍带
   watched 子会话与第一条通知 —— 证明 Host 重启后 hub 从持久记录重建了索引；
3. 对冷子会话发第二次 prompt（`sessionController.resolveAgent` resume）→ 子会话产生新的
   `turn/end` → 冷 lead 投影里出现**新的**持久通知（只有重建索引 + `wakeColdSession` 默认
   true 才会发生）；
4. lead 被 resume 后 `/devlead status` 正常列出 watched 子会话与最近通知，最后 `/devlead off`
   翻转成功。

**阶段 2（实验组合 worktree happy path；`--no-worktree` 跳过）**

1. 停掉阶段 1 实例（同一 scratch root / 同一 profile）；
2. `enableWorktreeBundle()`：把官方 `@deepseek-ai/dsh-experimental-forge-bundle` 追加进该
   profile 的 `dsh.profile.bundles`。它由安装版内置的官方 bundle inventory 解析，**不需要
   pnpm install、不联网、不改 lockfile**；
3. `linkProbePackage()`：把私有测试包 `scripts/e2e-probe`
   （`@yankeguo/dsh-devlead-e2e-probe`，0.0.0）链接到 profile 的
   `node_modules/@yankeguo/`，作为 linked root；
4. `writeProbePatch()`：生成 probe overlay，插入 probe 插件行；patch 流把它叠加在原有 devlead
   overlay 之上，installed 流的 devlead 行仍来自 profile bundle 选择；
5. 用**同一加载流**重启 → `/devlead status` 断言 `Worktree isolation: available` → 通过 probe
   命令调用 core `useWorkspace(agent, request)` 注册 scratch workspace，再
   `createSession({ isolation: 'worktree' })` 创建未 prompt 的子会话并返回 JSON；
6. 断言隔离结果与真实 Git 状态：`status:'worktree'`、`path`/`branch`/`baseCommit` 非空、检出
   位于 `<workspace>/.agents/worktrees/`、`git worktree list --porcelain` 含该路径、
   `git show-ref --verify refs/heads/<branch>` 成功、`baseCommit === git rev-parse HEAD`、
   子会话有效 cwd == 检出路径、header cwd 保持为 workspace、Session 仍归属该 Workspace；
7. 停实例。scratch workspace 在 harness 里初始化成真实 git 仓库（一次 seed commit），因此这是
   真实 Git happy path，不是 mock。

**实际结果（Lead/e2e-dev，本轮工作树）**：`node scripts/e2e-smoke.mjs --no-build --flow patch`
与 `--flow installed` 均 → **61/61 checks PASS**（阶段 1 27 + 阶段 1b 12 + 阶段 2 22），阶段 1 含
`Session-list summary excludes the digest-bearing devLead projection` 与 `default profile
reports no optional worktree isolation :: Worktree isolation: unavailable`，阶段 1b 验证
Host 重启后的冷 lead 索引重建，阶段 2 含 `Worktree isolation: available` 与 worktree happy
path 断言。这证明「默认 Web 组合（base+web-app，无任何实验 bundle）可安装、可启动、可产出
全部产品行为」，持久状态可跨重启重建，并且可选 worktree 能力一旦被组合即可端到端工作；
是本审计结论最强的运行时证据。

**诚实边界**：E2E 只 `fetch /` 取 `__DSH_BOOT__` 并走 HTTP RPC，**不执行浏览器 JS**，因此它
证明的是"Host 侧全部功能 + client 条目进入 boot graph 且携带声明的 injects"，**不直接证明
client 条目激活成功**（rc.1 的严格审计发生在浏览器里）。client 激活的证据来自：
(a) §5.3 的静态提供者映射（5/5 默认组合覆盖）；(b) 历史审计中在真实 Chrome 对隔离 DSH
实例做过两个 UI 状态的人工渲染验证，并据此刷新截图（`docs/AUDIT.md`「遗留限制」的人工 Chrome 验证条目）；
(c) 历史 E2E 两条加载流 25/25 通过（`docs/AUDIT.md` §8 验证矩阵）。浏览器在默认组合下能否
无 pending 激活，仍建议在 RC 回归清单里保留一次"真 Chrome 打开默认 profile"的人工检查。

### 7.5 静态扫描证据（本审计已执行）

```sh
grep -rn "dsh-experimental" packages/*/src packages/*/tests packages/*/package.json \
  packages/bundle/cordis.patch.yml scripts
```

结果：`packages/*`、`packages/bundle/cordis.patch.yml` 中的命中都是"必须不包含"的反向断言
（源码扫描、每个 manifest、bundle patch；`packages/devlead/tests/isolation.spec.ts` 的
`experimental dependency surface`）。`scripts/e2e-smoke.mjs` 额外以字符串常量
`WORKTREE_BUNDLE = '@deepseek-ai/dsh-experimental-forge-bundle'` 引用官方包——那是 E2E 阶段 2
在**一次性 scratch profile** 里显式组合实验能力所必需（不是产品依赖、不写入任何 manifest/
lockfile，`check-packages` 仍通过）。`worktrees` 字面量在 src 中仅出现在
`packages/devlead/src/isolation.ts` 的 `ctx.get('worktrees')` 与 `packages/tool/src/policy.ts`
的提示文案；**无 inject、无 import、无 package.json 声明**。

打包不变式本次已运行通过：`node scripts/check-packages.mjs` → `check-packages: OK (6 packages)`。
该检查是本审计的 H1/H2/H3 兜底：host 运行期 `@deepseek-ai/*` 导入必须声明为 peer；
DSH 包不得作为直接/optional 依赖、不得声明 `dsh-experimental`；浏览器 `@deepseek-ai/*` 导入
必须在 module table 内；`dsh.client.inject` 的每个 id 必须是 root devDependency 或平台单例。

### 7.6 本审计未运行、由 Lead 运行/负责的部分

- 本审计自己执行：只读检查 + 临时 `DSH_HOME` 的 dump-config 实验（§7.1）+ E1 asar 读取
  （§7.2）+ 静态扫描（§7.5）+ `node scripts/check-packages.mjs`（通过）。
- Lead 在 0.2.0 工作树执行并通过（最终值）：`pnpm verify`（typecheck + `pnpm test`：
  22 文件 / 558 tests + 7 个构建产物）、`node scripts/check-packages.mjs`
  （`OK (6 packages)`）、`node scripts/e2e-smoke.mjs --no-build --flow patch` 与
  `--flow installed`（各 **61/61**：阶段 1 27 + 阶段 1b 12 + 阶段 2 22），含默认组合
  `Worktree isolation: unavailable`、Host 重启后冷 lead 索引重建、可选 worktree 组合
  `available`、summary 不携带 digest 的断言，以及真实 Git worktree happy path。
- 发布前仍需做：registry 安装回归（R3）。§9 R8 已由 0.2.0 的 E2E 阶段 2 覆盖（真实实验组合
  happy path），不再是"未实测"项。

## 8. 与 `.tmp/research/workspace-api.md` 的差异

**无实质矛盾**。三项独立结论一致：

- 该笔记 §6 判定 worktree 是实验性、默认组合不提供、且不与 Workspace 映射 —— 与本审计 §3.5
  和 §6.5 一致；
- §8.3 判定 headless/ACP 不挂 `dsh-workspace`/`dsh-api-workspace-controller` —— 与本审计
  §6.4 一致（并补充：sdk-app 挂 registry 但无 controller）；
- §8.1 的 `ctx.worktrees` 为 pending 型可选服务 —— 与本审计的能力探测结论一致。

需要校正/补充的两点：

1. **行号以 tag 为准**。该笔记引用的 web-app patch 行号来自 DSH 源码 **HEAD**
   （`fcc0ad46`，比 rc.1 tag 晚 811 个提交），例如它把 `workspace-controller` 记在
   `:158-159`、`ui-workspace` 记在 `:374-375`；rc.1 tag 实际是 `:150` 与 `:366`。
   行号漂移不影响其组合语义结论，但引用 0.2.2-rc.1 时应使用 tag 行号（本文 E2 口径）。
2. **`sessionTitle` / `sessionQuery` 服务本身是 base 默认提供**（`DSH:base:60` 与
   `:149-160`）。实验性 `session-titles-bundle` 只是**替换标题刷新插件**，不是 `sessionTitle`
   服务的唯一来源。因此本套件对这两个服务的可选用法是"防御性可选"，不是"依赖实验 bundle"
   ——这一点在阅读 Lead 前提「session-titles 是实验性默认关闭」时需要区分：**bundle** 默认关闭
   （`DSH:bundles.ts:61`），**服务**默认开启。

## 9. 遗留风险与需用户决策项

| # | 风险 | 评估 | 建议/决策 |
| --- | --- | --- | --- |
| R1 | **client 半边对默认 Web 组合是硬依赖**：rc.1 客户端启动审计严格，devlead-ui 的 5 个必需服务若在自定义（非默认）Web 组合中缺失，`web boot` 整页失败，而不是仅隐藏控件 | 默认 Web/Desktop 组合 5/5 覆盖（§5.3）；自定义组合才触发 | 方案 A（推荐）：把"仅默认 Web 组合受支持"写成硬契约（README/DESIGN 已声明），不改代码。方案 B：改成 Optional inject + `ctx.get` 守卫，可让自定义组合不崩，但 UI 会半残且改动面大；方案 C：在插件市场元数据里声明限制。需用户拍板 |
| R2 | `peerDependencies` 精确锁 `0.2.2-rc.1`，而运行时准入只看 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0`）；同一 0.2.2 线上的 API 漂移不会在准入时被拦 | 中 | 每升一个 rc 都要同步 peers（CI/check-packages 已在 root devDeps 侧强制一致），并在 release checklist 里保留真实 E2E 回归；是否放宽为 `~0.2.2-rc.1` 需决策 |
| R3 | **registry 安装路径未在本机验证**：本机只验证了「符号链接/linked-root 安装」；`dsh plugin add @yankeguo/dsh-devlead-bundle`（发布后）走 pnpm profile 安装，依赖 DSH runtime resolution 提供 peers（profile `pnpm-workspace.yaml` 固定 `autoInstallPeers: false`，`DSH:packages/boot/app-boot/src/profile.ts:184-189` tag） | 中（发布前必经） | 首次发布后在干净 profile 上跑一次 registry 安装 + E2E；本地 e2e 的 `installed` 流用符号链接，不等价 |
| R4 | 实验性 worktree 服务是**结构 duck-type**：未来 rc 若移除 `create`，DevLead 报 `unavailable`；若 `create` 抛错或返回畸形结果，报 `failed`（都不会崩），但不会主动报"版本不匹配" | 低 | 接受；`isolation.spec.ts` 已覆盖"畸形服务→unavailable"与"畸形结果→failed" |
| R5 | headless/acp/sdk 组合可安装本套件但 dispatch 不可用（§6.4），当前只有 README 一句"面向默认 Web 组合" | 低-中 | 决策：是否在详细文档/插件描述中显式标注"Web/Desktop 完整支持；headless/ACP 仅模式与只读可用"？代码侧不建议加硬限制（会妨碍未来组合） |
| R6 | `dsh.client.inject` 里有非 client row 的名字（`dsh-client-ui-primitives`）；rc.1 loader 忽略之，保留作文档（`docs/AUDIT.md` 遗留限制） | 低 | 观察：若未来 DSH 改为严格校验 inject 名字，需移除该项；当前不动 |
| R7 | `dsh-api-gateway`（提供 client `remote` 服务）未在本套件任何清单中出现 | 低 | 它是默认组合的传递依赖，且我们的代码没有直接 import/peer；保持不声明（声明反而会误导安装） |
| R8 | ~~worktree 隔离 happy path 未在真实实验组合上实测~~：**0.2.0 已解决**。本地 E2E 阶段 2 在一次性 profile 里显式追加官方 `@deepseek-ai/dsh-experimental-forge-bundle`，通过私有 probe 命令走 `useWorkspace(agent, request)` + `createSession({ isolation: 'worktree' })`，对真实 git 仓库端到端断言 isolation 结果、worktree/分支存在、baseCommit、子会话有效 cwd 与 header cwd、Workspace 归属 | 已关闭 | 保留为本地验收的一部分（每流 61/61）；无需再手动验收 |

## 10. 附录：复现命令

**A. 读取安装运行时 `app.asar`（只读，不落盘）**

```js
// dataBase = 8 + headerSize；用条目 integrity(SHA-256) 校验偏移
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)   // header pickle 长度
const jsonSize = head.readUInt32LE(12)    // JSON 长度
const headerBuf = Buffer.alloc(jsonSize); fs.readSync(fd, headerBuf, 0, jsonSize, 16)
const dataBase = 8 + headerSize           // 本机 = 5,748,764
// 之后每个条目：readSync(fd, buf, 0, entry.size, dataBase + Number(entry.offset))
```

**B. 默认组合 dump（不触碰真实 `~/.dsh`）**

```sh
TMP=$(mktemp -d /tmp/devlead-optdep-audit-XXXXXX); mkdir -p "$TMP/home"
cd "$TMP"
DSH_HOME="$TMP/home" dsh devlead-audit --from-default-profile web --dump-config > dump.yml
grep -c "name: '@deepseek-ai/" dump.yml            # 本机：291
grep -E "dsh-experimental|dsh-personalized|dsh-cua" dump.yml  # 本机：无输出
cat "$TMP/home/profiles/devlead-audit/package.json" # bundles: base + web-app
```

**C. 复核 DSH rc.1 组合事实**

```sh
cd /Users/guoyk/Workspace/src/deepseek-harness
git show dsh-v0.2.2-rc.1:packages/bundle/base/cordis.patch.yml    # base 行
git show dsh-v0.2.2-rc.1:packages/bundle/web-app/cordis.patch.yml # web 行
git show dsh-v0.2.2-rc.1:packages/util/official-bundles/src/bundles.ts # 模板/可选/retired
git diff --numstat dsh-v0.2.2-rc.1 HEAD -- <path>  # 任何"HEAD vs rc.1"的漂移自查
```
