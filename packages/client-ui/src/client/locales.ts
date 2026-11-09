/** `devlead` namespace dictionaries. */

/**
 * Simplified Chinese dictionary: the key-set source of truth. Template
 * placeholders are `{name}` tokens interpolated by the locale runtime.
 */
export const zh = {
  'meta.title': 'DevLead 模式',
  'meta.description': '在输入框工具条中开关 DevLead 模式；开启后在输入框上方显示状态条、监督会话状态与最近一条通知。',
  'bar.aria': 'DevLead 状态栏',
  'label': 'DevLead',
  'switch.aria': 'DevLead 模式',
  'switch.disable': '关闭 DevLead 模式',
  'switch.pending': '正在执行 DevLead 命令…',
  'hint.enabled': 'DevLead 已开启：子会话的轮次结束会通知并唤醒本会话。',
  'count.watched': '监督 {count} 个会话',
  'count.running': '运行中 {count}',
  'count.missing': '{count} 个已不可用',
  'toggle.enable': '开启 DevLead 模式',
  'toggle.failed': '开启 DevLead 模式失败：{message}（悬停查看，可重试）',
  'toggle.failed.status': '开启 DevLead 模式失败：{message}',
  'notification.turn': '第 {turn} 轮',
  'transition.completed': '完成',
  'transition.error': '失败',
  'transition.blocked': '阻塞',
  'transition.aborted': '已取消',
  'transition.max-tokens': '超出输出上限',
  'transition.interrupted': '已中断',
  'transition.forked': '已分叉',
  'transition.unknown': '未知状态',
  'error.command': '命令失败：{message}（{code}）',
  'error.rejected': '命令被拒绝：{message}',
  'error.unknown': '命令执行失败：{message}',
  'error.unresolved': '命令未执行：Host 未识别 {line}',
} satisfies Record<string, string>

/** The `devlead` namespace key union. */
export type DevLeadKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'meta.title': 'DevLead mode',
  'meta.description': 'Toggles DevLead mode from the composer toolbar; once enabled, a status strip above the composer shows watched sessions and the latest notification.',
  'bar.aria': 'DevLead status bar',
  'label': 'DevLead',
  'switch.aria': 'DevLead mode',
  'switch.disable': 'Turn off DevLead mode',
  'switch.pending': 'Running the DevLead command…',
  'hint.enabled': 'DevLead is on: watched-session turn changes notify and wake this session.',
  'count.watched': '{count} watched',
  'count.running': '{count} running',
  'count.missing': '{count} unavailable',
  'toggle.enable': 'Turn on DevLead mode',
  'toggle.failed': 'Could not turn on DevLead mode: {message} (hover to read, then retry)',
  'toggle.failed.status': 'Could not turn on DevLead mode: {message}',
  'notification.turn': 'turn {turn}',
  'transition.completed': 'completed',
  'transition.error': 'failed',
  'transition.blocked': 'blocked',
  'transition.aborted': 'cancelled',
  'transition.max-tokens': 'hit the token limit',
  'transition.interrupted': 'interrupted',
  'transition.forked': 'forked',
  'transition.unknown': 'unknown state',
  'error.command': 'Command failed: {message} ({code})',
  'error.rejected': 'Command rejected: {message}',
  'error.unknown': 'Command failed: {message}',
  'error.unresolved': 'Command did not run: the Host did not recognize {line}',
} satisfies Record<DevLeadKey, string>
