# @yankeguo/dsh-command-devlead

The human-facing `/devlead` command behind the UI mode switch; it also owns watch-set changes and
the human-readable status view. The status output includes `Worktree isolation: available|unavailable`
so a human can see whether the optional checkout-isolation capability is composed.

```text
/devlead                         # status: mode, worktree capability, watched sessions, recent notifications
/devlead on                      # enable DevLead mode for this Session (human-only)
/devlead off                     # disable it
/devlead watch <session>         # watch a Session by full id or unique prefix
/devlead unwatch <session>       # stop watching it
```

The command parses the DSH `CommandInvocation.rawInput` contract (text after the command name),
does not accept composer attachments, and renders domain failures as friendly text instead of
throwing. Prefix references are confirmed with the core's exhaustive resolver before a watch
mutation, so a bounded listing cannot silently shadow another matching Session.

## Install

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: command contract and error mapping](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)

## 中文

`@yankeguo/dsh-command-devlead` 提供人类 `/devlead` 命令：状态、开关、watch/unwatch。命令按
DSH `rawInput` 契约解析，不接受附件，前缀引用在变更前由 core 穷尽验证。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
