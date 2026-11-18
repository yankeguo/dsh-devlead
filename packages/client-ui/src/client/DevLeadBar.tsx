/**
 * DevLeadBar: the DevLead status strip docked above the message composer
 * (`conversation.input.dock`).
 *
 * The strip renders only while DevLead mode is enabled for this Session. It is
 * a pure status surface: it owns no switch and sends no command. The single
 * mode switch is the composer-toolbar toggle (`DevLeadIconToggle`,
 * `conversation.input.left`), which stays mounted in both states — so turning
 * the mode off can never hide the control that did it. Installing the plugin
 * still does not put a permanent bar above every conversation.
 *
 * Enabled state shows the brand, the watched/running counts, and the latest
 * retained notification (or the help hint when there is none). Durable state
 * arrives through the `devLead` projection; this surface never writes it.
 */

import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVLEAD_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import {
  latestNotification,
  notificationSummary,
  summarizeWatched,
} from './format.ts'

/** Full props of the dock entry: runtime share + locale seat. */
export type DevLeadBarProps =
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'devlead'>

/** The DevLead strip above the composer, rendered only in enabled mode. */
export function DevLeadBar({
  useProjection, useSessions, useSessionStatus, t,
}: DevLeadBarProps) {
  const projection = useProjection(DEVLEAD_PROJECTION_KEY)
  // Both sources are selector hooks over framework snapshots; the explicit
  // parameter types keep this component typed even in a workspace that does not
  // install the shell store package that declares the canonical hook shape.
  const rows = useSessions((state: SessionListState) => state.byId)
  const statuses = useSessionStatus((current: SessionStatusSnapshot) => current)
  const enabled = projection?.enabled ?? false

  if (projection === undefined || !enabled) return null

  const summary = summarizeWatched(projection.sessions, rows, statuses)
  const latest = latestNotification(projection.notifications)
  const notice = latest === null ? null : notificationSummary(latest)

  return (
    <div
      className="devlead-dock"
      data-devlead-bar="true"
      data-devlead-enabled="true"
    >
      <div
        className="devlead-bar"
        role="group"
        aria-label={t('bar.aria')}
        title={t('hint.enabled')}
      >
        <span className="devlead-glyph" aria-hidden="true">
          <IconUsersOutlineRegular size={14} />
        </span>
        <span className="devlead-label">{t('label')}</span>
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
      </div>
    </div>
  )
}
