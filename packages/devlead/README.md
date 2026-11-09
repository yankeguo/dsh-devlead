# @yankeguo/dsh-devlead

Core Host service of the DevLead suite (`ctx.devLead`): the durable mode switch, Workspace and
Session orchestration, the watched-session notification hub, and the `devLead` / `devLeadMode`
Session projections.

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0` (the installed runtime is `0.2.2-rc.1`).
- Peer services `agents`, `sessions`, `sessionProjections` (provided by the default `dsh-base`
  composition).
- Optional, probed at call time: `workspaceRegistry`, `sessionController`, `sessionTitle`,
  `sessionQuery`, and the experimental `worktrees` capability. Missing optional services degrade
  to fewer features or structured domain errors; no experimental package is imported, injected,
  or declared.

## Configuration

The Loader row id `devlead` accepts `notificationBatchMs`, `maxWatchedSessions`,
`maxListedSessions`, `wakeColdSession`, and `defaultAgentPreset`. See the
[configuration section](https://github.com/yankeguo/dsh-devlead/blob/main/README.md#configuration) for defaults and ranges; all limits are
validated at both the Loader and direct-construction boundaries.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: service API, projections, notification pump, worktree isolation](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-devlead` 是套件的 Host 核心服务 `ctx.devLead`：模式开关、Workspace/Session
编排、watch 索引、通知投递，以及 `devLead` / `devLeadMode` projection。`agents`、`sessions`、
`sessionProjections` 为必需 peer；Workspace registry、Session controller、标题/查询服务与实验性
worktree 能力均为可选探测。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
