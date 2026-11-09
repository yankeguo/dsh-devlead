/**
 * DevLeadBar: the DevLead status strip docked above the message composer
 * (`conversation.input.dock`).
 *
 * The strip has three render states:
 * - loading (`undefined` projection) renders nothing, so it cannot claim a mode
 *   before the Session log baseline arrives;
 * - disabled mode renders one compact row: the brand, the label, and the switch
 *   that turns DevLead on;
 * - enabled mode adds the watched/running counts, the latest retained
 *   notification, and the help hint (carried by the row's `title`).
 *
 * The switch is controlled by the projection only — never optimistically
 * flipped. A click executes the Host `/devlead on|off` command through the
 * injected face, and the mode renders from the projection once the Host append
 * lands. Both failure layers (a failed Remote admission and a logical command
 * rejection) surface inline; the strip never swallows them.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconUsersOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  latestNotification,
  notificationSummary,
  summarizeWatched,
} from './format.ts'
import {
  commandFailure,
  failureCopy,
  unexpectedFailure,
  type DevLeadCommandAdmission,
  type DevLeadCommandFailure,
} from './results.ts'

/** Injected business face of the dock entry: command admission bound to this Session. */
export interface DevLeadDockInjected {
  /**
   * Execute one `/devlead` line against the dock's Session.
   * @param line - the full command line, leading slash included.
   * @returns the Host admission result.
   */
  readonly executeCommand: (line: string) => Promise<DevLeadCommandAdmission>
}

/** Full props of the dock entry: runtime share + injected face + locale seat. */
export type DevLeadBarProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<DevLeadDockInjected> & PropsLocale<'devlead'>

/** The DevLead strip above the composer. */
export function DevLeadBar({
  useProjection, useSessions, useSessionStatus, executeCommand, t,
}: DevLeadBarProps) {
  const projection = useProjection('devLead')
  // Both sources are selector hooks over framework snapshots; the explicit
  // parameter types keep this component typed even in a workspace that does not
  // install the shell store package that declares the canonical hook shape.
  const rows = useSessions((state: SessionListState) => state.byId)
  const statuses = useSessionStatus((current: SessionStatusSnapshot) => current)
  const enabled = projection?.enabled ?? false

  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<DevLeadCommandFailure | null>(null)
  // React state disables the switch on the next render; the ref closes the
  // same-render window so a rapid double click cannot admit two commands.
  const pendingRef = useRef(false)

  // A mode change from any source invalidates feedback that belonged to the
  // previous attempt; a failed toggle leaves `enabled` untouched, so its error
  // stays visible.
  useEffect(() => {
    setFailure(null)
  }, [enabled])

  const run = useCallback(async (line: string): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setFailure(null)
    try {
      const result = await executeCommand(line)
      // The Remote call can succeed while the command itself settles as a
      // logical error (no live Agent for `on`, invalid grammar); that text must
      // reach the strip instead of being dropped.
      const rejected = commandFailure(result)
      if (rejected !== undefined) setFailure(rejected)
    } catch (error) {
      setFailure(unexpectedFailure(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [executeCommand])

  if (projection === undefined) return null

  const summary = summarizeWatched(projection.sessions, rows, statuses)
  const latest = latestNotification(projection.notifications)
  const notice = latest === null ? null : notificationSummary(latest)
  const failureLine = failure === null ? null : failureCopy(failure)
  const switchTitle = pending ? t('switch.pending') : enabled ? t('switch.disable') : t('switch.enable')

  const toggle = (next: boolean): void => {
    void run(next ? '/devlead on' : '/devlead off')
  }

  return (
    <div
      className="devlead-dock"
      data-devlead-bar="true"
      data-devlead-enabled={enabled ? 'true' : 'false'}
      data-devlead-pending={pending ? 'true' : 'false'}
    >
      <div
        className="devlead-bar"
        role="group"
        aria-label={t('bar.aria')}
        aria-busy={pending}
        title={enabled ? t('hint.enabled') : t('hint.disabled')}
      >
        <span className="devlead-glyph" aria-hidden="true">
          <IconUsersOutlineRegular size={14} />
        </span>
        <span className="devlead-label">{t('label')}</span>
        <Switch
          className="devlead-switch"
          checked={enabled}
          disabled={pending}
          label={t('switch.aria')}
          title={switchTitle}
          onChange={toggle}
        />
        {enabled && (
          <>
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
            {notice === null ? (
              // An enabled Session with no retained notification keeps the help
              // hint visible instead of leaving the row visually empty.
              <span className="devlead-hint" title={t('hint.enabled')}>{t('hint.enabled')}</span>
            ) : (
              <span className="devlead-notification" title={notice.tooltip}>
                <span
                  className="devlead-notification-dot"
                  data-transition={notice.transition}
                  aria-hidden="true"
                />
                <span className="devlead-notification-who">{notice.who}</span>
                {notice.turn > 0 && (
                  <span className="devlead-notification-turn">{t('notification.turn', { turn: notice.turn })}</span>
                )}
                <span className="devlead-notification-label">{t(notice.labelKey)}</span>
                {notice.error !== undefined && (
                  <span className="devlead-notification-error">{notice.error}</span>
                )}
              </span>
            )}
          </>
        )}
        {failureLine !== null && (
          <span className="devlead-error" role="alert">{t(failureLine.key, failureLine.params)}</span>
        )}
      </div>
    </div>
  )
}
