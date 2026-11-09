# @yankeguo/dsh-tool-devlead

The eight model-facing `devlead_*` tools and the conditional DevLead system-prompt section.

The tools are registered with `when: ({ agent }) => ctx.devLead.isEnabled(agent)`, so an ordinary
Session never sees them. They become visible only after a human enables DevLead mode with
`/devlead on` or the UI switch.

## Tools

- `devlead_list_workspaces`
- `devlead_use_workspace`
- `devlead_list_sessions`
- `devlead_create_session` (optional `isolation: "none" | "worktree"`)
- `devlead_get_session`
- `devlead_prompt_session`
- `devlead_watch_session`
- `devlead_notifications`

Every tool except `devlead_list_workspaces` requires a live calling Agent (`exec.agent`) and an
enabled DevLead mode. Since 0.2.0 `devlead_use_workspace` forwards the live Agent to the core
`useWorkspace(agent, { path, title?, create? }, signal)`; `create` defaults to `false` (a missing
directory is `DEVLEAD_DIRECTORY_MISSING`), and `create: true` is only for a human-explicit request
to create the directory. Domain failures are translated to `HarnessError` with a stable
`DEVLEAD_*` code. Tool outputs are canonical JSON validated against their declared output
schemas.

## Install

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

The package peer-depends on the default DSH composition; see the repository README for the
supported platform.

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: tools, behavior policy, presentation](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)

## 中文

`@yankeguo/dsh-tool-devlead` 提供 8 个模型工具 `devlead_*` 与条件 system prompt，只在 DevLead
模式开启时可见。除 `devlead_list_workspaces` 外都需要 live 调用者；0.2.0 起
`devlead_use_workspace` 把 live Agent 转发给 core 的 `useWorkspace(agent, request, signal)`，
`create` 默认 `false`（缺目录报 `DEVLEAD_DIRECTORY_MISSING`，只有人类明确要求建目录时才传
`true`）。领域错误翻译为稳定的 `DEVLEAD_*` code。完整中文文档见[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与
[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
