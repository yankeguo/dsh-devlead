/** `devlead` namespace dictionaries. */

/**
 * Simplified Chinese dictionary: the key-set source of truth. Template
 * placeholders are `{name}` tokens interpolated by the locale runtime.
 */
export const zh = {
  'meta.title': 'DevLead 界面',
  'meta.description': 'DevLead 模式的 Web 界面：输入框工具条的 DevLead 开关（两态均可切换）、模式开启后显示的状态条，以及侧边栏中已开启会话的 DevLead 标记。',
  'bar.aria': 'DevLead 状态栏',
  'label': 'DevLead',
  'hint.enabled': 'DevLead 已开启：被监督会话的轮次结束会通知并唤醒本会话。',
  'count.watched': '监督 {count} 个会话',
  'count.running': '运行中 {count}',
  'count.missing': '{count} 个已不可用',
  'row.mark.aria': 'DevLead 模式已启用',
  'row.hover.enabled': 'DevLead 模式已启用：本会话可调度并监督其他会话。',
  'toggle.label': 'DevLead',
  'toggle.enable': '开启 DevLead 模式',
  'toggle.disable': '关闭 DevLead 模式',
  'toggle.pending': '正在执行 DevLead 命令…',
  'toggle.failed': '开启 DevLead 模式失败：{message}',
  'toggle.failed.disable': '关闭 DevLead 模式失败：{message}',
  'toggle.failed.status': '开启 DevLead 模式失败：{message}',
  'toggle.failed.status.disable': '关闭 DevLead 模式失败：{message}',
  'notification.turn': '第 {turn} 轮',
  'transition.completed': '完成',
  'transition.error': '失败',
  'transition.blocked': '阻塞',
  'transition.aborted': '已取消',
  'transition.max-tokens': '超出输出上限',
  'transition.interrupted': '已中断',
  'transition.forked': '已分叉',
  'transition.unknown': '未知状态',
  'error.fallback.transport': '命令失败',
  'error.fallback.rejected': '命令被拒绝',
  'error.fallback.unknown': '未知错误',
  'error.fallback.unresolved': 'Host 未识别该命令',
} satisfies Record<string, string>

/** The `devlead` namespace key union. */
export type DevLeadKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'meta.title': 'DevLead UI',
  'meta.description': 'Web UI for DevLead mode: the composer-toolbar toggle that switches the mode on or off, the status strip shown while the mode is on, and the DevLead mark on enabled Sessions in the sidebar.',
  'bar.aria': 'DevLead status bar',
  'label': 'DevLead',
  'hint.enabled': 'DevLead is on: watched-session turn changes notify and wake this session.',
  'count.watched': '{count} watched',
  'count.running': '{count} running',
  'count.missing': '{count} unavailable',
  'row.mark.aria': 'DevLead mode is on',
  'row.hover.enabled': 'DevLead mode is on: this session can dispatch and watch other Sessions.',
  'toggle.label': 'DevLead',
  'toggle.enable': 'Turn on DevLead mode',
  'toggle.disable': 'Turn off DevLead mode',
  'toggle.pending': 'Running the DevLead command…',
  'toggle.failed': 'Could not turn on DevLead mode: {message}',
  'toggle.failed.disable': 'Could not turn off DevLead mode: {message}',
  'toggle.failed.status': 'Could not turn on DevLead mode: {message}',
  'toggle.failed.status.disable': 'Could not turn off DevLead mode: {message}',
  'notification.turn': 'turn {turn}',
  'transition.completed': 'completed',
  'transition.error': 'failed',
  'transition.blocked': 'blocked',
  'transition.aborted': 'cancelled',
  'transition.max-tokens': 'hit the token limit',
  'transition.interrupted': 'interrupted',
  'transition.forked': 'forked',
  'transition.unknown': 'unknown state',
  'error.fallback.transport': 'command failed',
  'error.fallback.rejected': 'command rejected',
  'error.fallback.unknown': 'unknown error',
  'error.fallback.unresolved': 'the Host did not recognize the command',
} satisfies Record<DevLeadKey, string>
