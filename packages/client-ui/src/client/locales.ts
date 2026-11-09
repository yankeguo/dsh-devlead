/** `devlead` namespace dictionaries. */

/**
 * Simplified Chinese dictionary: the key-set source of truth. Template
 * placeholders are `{name}` tokens interpolated by the locale runtime.
 */
export const zh = {
  'meta.title': 'DevLead 状态栏',
  'meta.description': '在输入框上方展示 DevLead 模式开关、监督会话的运行状态与最近一条通知。',
  'bar.aria': 'DevLead 状态栏',
  'label': 'DevLead',
  'switch.aria': 'DevLead 模式',
  'switch.enable': '开启 DevLead 模式',
  'switch.disable': '关闭 DevLead 模式',
  'switch.pending': '正在执行 DevLead 命令…',
  'hint.disabled': '开启后，本会话可以创建、续写并监督其他普通会话；子会话的轮次结束时会提示并唤醒本会话。',
  'hint.enabled': 'DevLead 已开启：子会话的轮次结束会通知并唤醒本会话。',
  'count.watched': '监督 {count} 个会话',
  'count.running': '运行中 {count}',
  'count.missing': '{count} 个已不可用',
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
} satisfies Record<string, string>

/** The `devlead` namespace key union. */
export type DevLeadKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'meta.title': 'DevLead Bar',
  'meta.description': 'Shows the DevLead mode switch, watched-session status, and the latest notification above the composer.',
  'bar.aria': 'DevLead status bar',
  'label': 'DevLead',
  'switch.aria': 'DevLead mode',
  'switch.enable': 'Turn on DevLead mode',
  'switch.disable': 'Turn off DevLead mode',
  'switch.pending': 'Running the DevLead command…',
  'hint.disabled': 'Turn this on to create, continue, and supervise ordinary sessions from this one; watched-session turn changes notify and wake this session.',
  'hint.enabled': 'DevLead is on: watched-session turn changes notify and wake this session.',
  'count.watched': '{count} watched',
  'count.running': '{count} running',
  'count.missing': '{count} unavailable',
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
} satisfies Record<DevLeadKey, string>
