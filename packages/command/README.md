# @yankeguo/dsh-command-devlead

The human-facing `/devlead` command behind the composer-toolbar toggle; it also owns watch-set changes,
damage recovery, and the human-readable status view. The status output includes
`Worktree isolation: available|unavailable` so a human can see whether the optional
checkout-isolation capability is composed.

```text
/devlead                         # status: mode, worktree capability, watched sessions, recent notifications/reports
/devlead on                      # enable DevLead mode for this Session (human-only)
/devlead off                     # disable it; on a frozen fold it recovers by resetting the damaged state
/devlead reset                   # human-only recovery: discard this Session's DevLead state (mode/watch/digest)
/devlead watch <session>         # watch a Session by full id or unique prefix
/devlead unwatch <session>       # stop watching it
```

DevLead mode is Host-wide and single-active: exactly one Session may hold it across every
Workspace. `/devlead on` in a second Session is refused with `DEVLEAD_ALREADY_ACTIVE`, whose
message names the occupying Session and says to run `/devlead off` there first; the refused
Session's projection stays disabled. Off/reset release the slot immediately, and archiving the
holder makes it releasable on the next admission/startup (the core writes the durable mode-off
when it can).

The command parses the DSH `CommandInvocation.rawInput` contract (text after the command name),
does not accept composer attachments, and renders domain failures as friendly text instead of
throwing. Prefix references are confirmed with the core's exhaustive resolver before a watch
mutation, so a bounded listing cannot silently shadow another matching Session. Outcome titles are
derived from a post-mutation snapshot, so a concurrent command cannot leave the title describing a
different state than the rendered body.

The status view also renders the five newest mid-turn reports (`Recent reports:`) with timestamp,
sender, kind, and summary/message; report errors (not-supervised, rate-limited, invalid fields) are
rendered as friendly command text. A report is not sent by the command itself; watched Sessions
use the `devlead_report` tool.

`/devlead reset` appends a `plugin:devlead/reset` durable record: replay applies it before the
corruption freeze check, so a Session whose earlier `plugin:devlead/*` record is corrupt becomes
usable again (both projections restart from the default disabled state). `/devlead off` runs the
same recovery when the fold is frozen; `/devlead on` refuses and asks for the explicit reset.

## Install

Normally installed as part of the bundle:

```sh
dsh plugin --profile desktop add @yankeguo/dsh-devlead-bundle
```

## Related docs

- [Repository README (English)](https://github.com/yankeguo/dsh-devlead/blob/main/README.md) / [中文](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)
- [Design notes: command contract and error mapping](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)

## 中文

`@yankeguo/dsh-command-devlead` 提供人类 `/devlead` 命令：模式状态、reset、watch/unwatch。
DevLead 模式全局单活：第二个会话执行 `/devlead on` 会以 `DEVLEAD_ALREADY_ACTIVE` 被拒，
消息给出占用者并提示先在占用者上 `/devlead off`；关闭/重置立即释放，归档占用者在下一次
准入/启动时可被释放。
状态视图还会列出最近 5 条中途汇报（`Recent reports:`，含时间、sender、kind、summary/message）；
not-supervised / rate-limited / 参数错误都会转成友好命令文本。命令本身不发送汇报；被监督会话
使用 `devlead_report` 工具。
0.2.0 起 `/devlead reset`（以及冻结时 `/devlead off`）追加 `plugin:devlead/reset` 记录并解冻
损坏的 fold；reset 会丢弃该会话的 watch 集合与通知 digest。命令按 DSH `rawInput` 契约解析，
不接受附件，前缀引用在变更前由 core 穷尽验证，变更后的标题与正文来自同一 post-mutation 快照。完整中文文档见
[根 README.zh.md](https://github.com/yankeguo/dsh-devlead/blob/main/README.zh.md)与[设计说明](https://github.com/yankeguo/dsh-devlead/blob/main/docs/DESIGN.md)。
