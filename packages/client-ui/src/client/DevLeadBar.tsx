/**
 * DevLeadBar: the DevLead status strip docked above the message composer
 * (`conversation.input.dock`).
 *
 * The strip renders only while DevLead mode is enabled for this Session. An
 * inactive Session shows nothing here: the off-state switch lives in the
 * composer toolbar (`DevLeadIconToggle`, `conversation.input.left`), so
 * installing the plugin does not put a permanent bar above every conversation.
 *
 * Enabled state shows the brand, the on switch, the watched/running counts, and
 * the latest retained notification (or the help hint when there is none).
 *
 * The switch is controlled by the projection only — never optimistically
 * flipped. A click executes the Host `/devlead off` command through the
 * injected face, and the strip disappears from the projection once the Host
 * append lands. Every failure (a failed Remote admission, a logical command
 * rejection, or a line the Host resolved to no command) surfaces inline; the
 * strip never swallows it.
 */

import { IconUsersOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVLEAD_COMMAND_NAME, DEVLEAD_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import {
  latestNotification,
  notificationSummary,
  summarizeWatched,
} from './format.ts'
import { failureCopy, type DevLeadCommandAdmission } from './results.ts'
import { useDevLeadAdmission } from './useDevLeadAdmission.ts'

/** Injected business face shared by every DevLead surface: command admission. */
export interface DevLeadCommandInjected {
  /**
   * Execute one `/devlead` line against the surface's Session.
   * @param line - the full command line, leading slash included.
   * @returns the Host admission result.
   */
  readonly executeCommand: (line: string) => Promise<DevLeadCommandAdmission>
}

/** Full props of the dock entry: runtime share + injected face + locale seat. */
export type DevLeadBarProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<DevLeadCommandInjected> & PropsLocale<'devlead'>

/** The DevLead strip above the composer, rendered only in enabled mode. */
export function DevLeadBar({
  useProjection, useSessions, useSessionStatus, executeCommand, t,
}: DevLeadBarProps) {
  const projection = useProjection(DEVLEAD_PROJECTION_KEY)
  // Both sources are selector hooks over framework snapshots; the explicit
  // parameter types keep this component typed even in a workspace that does not
  // install the shell store package that declares the canonical hook shape.
  const rows = useSessions((state: SessionListState) => state.byId)
  const statuses = useSessionStatus((current: SessionStatusSnapshot) => current)
  const enabled = projection?.enabled ?? false
  const { pending, failure, run } = useDevLeadAdmission(executeCommand, enabled)

  if (projection === undefined || !enabled) return null

  const summary = summarizeWatched(projection.sessions, rows, statuses)
  const latest = latestNotification(projection.notifications)
  const notice = latest === null ? null : notificationSummary(latest)
  const failureLine = failure === null ? null : failureCopy(failure)
  const switchTitle = pending ? t('switch.pending') : t('switch.disable')

  // The strip only exists while enabled, so the only transition the switch can
  // request is turning the mode off; a reported check (for example a duplicated
  // click after the projection already caught up) is ignored.
  const toggle = (next: boolean): void => {
    if (next) return
    run(`/${DEVLEAD_COMMAND_NAME} off`)
  }

  return (
    <div
      className="devlead-dock"
      data-devlead-bar="true"
      data-devlead-enabled="true"
      data-devlead-pending={pending ? 'true' : 'false'}
    >
      <div
        className="devlead-bar"
        role="group"
        aria-label={t('bar.aria')}
        aria-busy={pending}
        title={t('hint.enabled')}
      >
        <span className="devlead-glyph" aria-hidden="true">
          <IconUsersOutlineRegular size={14} />
        </span>
        <span className="devlead-label">{t('label')}</span>
        <Switch
          className="devlead-switch"
          checked
          disabled={pending}
          label={t('switch.aria')}
          title={switchTitle}
          onChange={toggle}
        />
        <span className="devlead-meta">
          <span className="devlead-watched">{t('count.watched', { count: summary.watched })}</span>
          <span className="devlead-running">
            <span
              className="devlead-dot"
              data-active={summary.running > 0 ? 'true' : 'false'}
              aria-hidden="true"
            />
            <span>{t('count.running', { count: summary.running })}</span>
          </span>
          {summary.missing > 0 && (
            <span className="devlead-missing" title={t('count.missing', { count: summary.missing })}>
              {t('count.missing', { count: summary.missing })}
            </span>
          )}
        </span>
        <span
          className="devlead-notice"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          title={notice === null ? t('hint.enabled') : notice.tooltip}
        >
          {notice === null ? (
            // An enabled Session with no retained notification keeps the help
            // hint visible instead of leaving the row visually empty.
            <span className="devlead-hint">{t('hint.enabled')}</span>
          ) : (
            <span className="devlead-notification">
              <span
                className="devlead-notification-dot"
                data-transition={notice.transition}
                aria-hidden="true"
              />
              <span className="devlead-notification-who">{notice.who}</span>
              {notice.turn > 0 && (
                <span className="devlead-notification-turn">
                  {t('notification.turn', { turn: notice.turn })}
                </span>
              )}
              <span className="devlead-notification-label">{t(notice.labelKey)}</span>
              {notice.error !== undefined && (
                <span className="devlead-notification-error">{notice.error}</span>
              )}
            </span>
          )}
        </span>
        {failureLine !== null && (
          <span className="devlead-error" role="alert">{t(failureLine.key, failureLine.params)}</span>
        )}
      </div>
    </div>
  )
}
