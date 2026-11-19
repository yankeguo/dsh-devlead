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
 *
 * A subagent Session never renders the strip even when its projection still
 * folds as enabled (old data or a hand-edited log). The toolbar toggle is hidden
 * there too, so showing a strip would advertise a state the human could not
 * turn off from this surface.
 */

import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVLEAD_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import {
  epochMillis,
  latestNotification,
  latestReport,
  notificationSummary,
  reportSummary,
  summarizeWatched,
} from './format.ts'

/** Full props of the dock entry: runtime share + locale seat. */
export type DevLeadBarProps =
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'devlead'>

/** The DevLead strip above the composer, rendered only in enabled mode. */
export function DevLeadBar({
  useSession, useProjection, useSessions, useSessionStatus, t,
}: DevLeadBarProps) {
  // Unconditional hook: the surface must keep a stable hook order even when the
  // Session's subagent status changes between renders.
  const subagent = useSession((snapshot: SessionSnapshot) => snapshot.subagent !== null) ?? false
  const projection = useProjection(DEVLEAD_PROJECTION_KEY)
  // Both sources are selector hooks over framework snapshots; the explicit
  // parameter types keep this component typed even in a workspace that does not
  // install the shell store package that declares the canonical hook shape.
  const rows = useSessions((state: SessionListState) => state.byId)
  const statuses = useSessionStatus((current: SessionStatusSnapshot) => current)
  const enabled = projection?.enabled ?? false

  if (subagent) return null
  if (projection === undefined || !enabled) return null

  // Every collection below crossed the Remote boundary. The Host schemas
  // validate same-version payloads, but a cached bundle can meet a different
  // Host shape, so an unusable collection degrades to empty instead of
  // throwing through the composer dock.
  const watchedSessions = Array.isArray(projection.sessions) ? projection.sessions : []
  const notifications = Array.isArray(projection.notifications) ? projection.notifications : []
  const reports = Array.isArray(projection.reports) ? projection.reports : []

  const summary = summarizeWatched(watchedSessions, rows, statuses)
  const latest = latestNotification(notifications)
  const latestRep = latestReport(reports)
  // Both digest families share one strip: the newest retained row wins (a tie
  // goes to the report), and a report is a mid-turn update rather than a
  // settled-turn transition. Both instants are sanitized first: a drifted
  // non-finite `at` must not poison the comparison.
  const showReport = latestRep !== null
    && (latest === null || epochMillis(latestRep.at) >= epochMillis(latest.at))
  const notice = !showReport && latest !== null ? notificationSummary(latest) : null
  const reportNotice = showReport && latestRep !== null ? reportSummary(latestRep) : null
  const tooltip = reportNotice?.tooltip ?? notice?.tooltip ?? t('hint.enabled')

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
          title={tooltip}
        >
          {reportNotice !== null ? (
            <span className="devlead-notification" data-report="true">
              <span
                className="devlead-notification-dot"
                data-report-kind={reportNotice.kind}
                aria-hidden="true"
              />
              <span className="devlead-notification-who">{reportNotice.who}</span>
              <span className="devlead-notification-label">{t(reportNotice.labelKey)}</span>
              {reportNotice.detail !== undefined && (
                <span className="devlead-notification-detail">{reportNotice.detail}</span>
              )}
            </span>
          ) : notice === null ? (
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
              {notice.error !== undefined ? (
                // Only a real Host failure excerpt wears the error ink.
                <span className="devlead-notification-error">{notice.error}</span>
              ) : notice.summary !== undefined ? (
                // A settled turn's assistant excerpt is neutral detail, like a
                // report's summary: the dot and label carry the outcome.
                <span className="devlead-notification-detail">{notice.summary}</span>
              ) : null}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
