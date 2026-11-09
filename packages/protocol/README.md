# @yankeguo/dsh-devlead-protocol

Pure shared protocol for the DevLead plugin suite: durable record payloads, Session projection
types, formatting helpers, and the constants both the Host and the browser bundle use.

This package has **no runtime dependency** on any DSH package. Its single DSH import is a
type-only projection-map augmentation; it is erased at build time. Installing it alone does not
enable DevLead — install the bundle (below) to get the host service, tools, command, and UI.

## Install

Normally installed as part of the main bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

Only install this package directly when you are composing the suite yourself.

## Exports

| Export | Contents |
| --- | --- |
| `@yankeguo/dsh-devlead-protocol` | Host entry; re-exports the client-safe surface |
| `@yankeguo/dsh-devlead-protocol/client` | Browser-safe constants, types, and pure formatting helpers |
| `@yankeguo/dsh-devlead-protocol/package.json` | Package manifest |

The public contract includes the `devLead` / `devLeadMode` projection keys and types, durable
`plugin:devlead/*` record types and their version (mode / watch / notification / **reset**;
`DevLeadResetRecord` discards every earlier DevLead record of a Session and restarts both
projections from their empty state), retention/excerpt/instant constants, transition vocabulary,
`notificationLine` / `excerptLine` / `formatInstant`, the `DevLeadUseWorkspaceRequest` shape
(`{ path, title?, create? }`, `create` defaults to `false`), and the `DevLeadIsolation` outcome
carried by the required `DevLeadCreatedSession.isolation` field.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)
- [Optional-dependency audit](https://github.com/yankeguo/dsh-devlead/blob/main/docs/OPTIONAL-DEPENDENCIES.md)

## 中文

`@yankeguo/dsh-devlead-protocol` 是 DevLead 套件的纯协议包：host 与浏览器共用的类型、常量、
projection 键、`plugin:devlead/*` 持久记录类型（mode / watch / notification / reset）与格式化
函数，以及 `DevLeadUseWorkspaceRequest`、必填的 `DevLeadCreatedSession.isolation` 等请求/结果
形状。它没有运行时 DSH 依赖，通常随 bundle 安装。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
