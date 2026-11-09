# @yankeguo/dsh-devlead

Core Host service of the DevLead suite (`ctx.devLead`): the durable mode switch, damage-recovery
`reset()`, Workspace and Session orchestration (including `useWorkspace(agent, request, signal?)`
with directory creation opt-in), the watched-session notification hub with cold-lead rehydration,
and the `devLead` / `devLeadMode` Session projections.

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0` (the installed runtime is `0.2.2-rc.1`).
- Peer services `agents`, `sessions`, `sessionProjections` (provided by the default `dsh-base`
  composition).
- Optional, probed at call time: `workspaceRegistry`, `sessionController`, `sessionTitle`,
  `sessionQuery`, `sessionProjectionCache` (cold-lead rehydration pre-filter), `sessionPersistence`
  (durable-corpus readiness barrier), and the experimental `worktrees` capability. Missing optional services degrade to fewer features or structured domain
  errors; no experimental package is imported, injected, or declared.
- Cold-lead rehydration: at plugin load the hub rebuilds its watch index from durable state
  (`sessionQuery` listing → projection-cache pre-filter → exact fold; unclassified rows are capped
  at 64 full-log reads). Without a projection cache only live lead Sessions are recovered. A
  disposed lead keeps observing; `wakeColdSession` defaults to `true`, so a queued notification
  resumes the cold lead before delivering.

## Configuration

The Loader row id `devlead` accepts `notificationBatchMs`, `maxWatchedSessions`,
`maxListedSessions`, `wakeColdSession` (default `true` since 0.2.0), and `defaultAgentPreset`. See the
[configuration section](https://github.com/yankeguo/dsh-devlead/blob/main/README.md#configuration) for defaults and ranges; all limits are
validated at both the Loader and direct-construction boundaries.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: service API, projections, notification pump, worktree isolation](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-devlead` 是套件的 Host 核心服务 `ctx.devLead`：模式开关、损坏状态恢复
`reset()`、Workspace/Session 编排（`useWorkspace(agent, request, signal?)`，目录创建 opt-in）、
带冷 lead 索引重建的 watch 索引与通知投递，以及 `devLead` / `devLeadMode` projection。
`agents`、`sessions`、`sessionProjections` 为必需 peer；Workspace registry、Session controller、
标题/查询服务、projection cache、`sessionPersistence`（冷重建就绪屏障）与实验性 worktree 能力
均为可选探测。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
