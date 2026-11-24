/**
 * DevLeadSessionMark: the sidebar's DevLead marker for one Session row
 * (`sidebar.session.row.trailing`).
 *
 * The mark makes both row roles recognizable in the Session list instead of
 * only inside the open conversation: an enabled row gets a compact corner
 * badge that never changes the shell's selection ring, and a row watched
 * by the active lead gets a quiet target mark. It reads the summary-sized
 * `devLeadMode` and `devLeadWatch` projections (never the digest), and
 * activates, retains, or opens nothing: the enclosing row keeps every cell as
 * its activation area. The badge participates in the trailing seat's inline
 * flex layout after the time label, so it cannot paint over that label or the
 * separate action strip. The trailing seat is hidden by the shell while the row
 * is hovered or focused on hover-capable devices; the lead fact remains in the
 * leading seat's visually hidden companion and in the row's hover card.
 */

import { IconGoalOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { devLeadRowEnabled, devLeadRowSummaryOf, devLeadRowWatched } from './sessionMark.ts'

/** Full props of the row mark: row identity + runtime hooks + copy. */
export type DevLeadSessionMarkProps =
  PropsRuntime<'sidebar.session.row.trailing'>
  & PropsLocale<'devlead'>

/**
 * Render the DevLead mark for an enabled or watched Session row.
 * @param props.sessionId - Session this row shows.
 * @param props.useSessions - selector hook over the Session list store.
 * @param props.t - DevLead surface copy.
 * @returns the active corner badge, watched target, or nothing for a plain row.
 */
export function DevLeadSessionMark({ sessionId, useSessions, t }: DevLeadSessionMarkProps) {
  // The explicit parameter type keeps this component typed even in a workspace
  // that does not install the shell store package that declares the hook shape.
  const enabled = useSessions((state: SessionListState) => devLeadRowEnabled(devLeadRowSummaryOf(state.byId, sessionId)))
  const watched = useSessions((state: SessionListState) => devLeadRowWatched(sessionId, state.byId))
  if (enabled) {
    return (
      <span
        className="devlead-row-mark devlead-row-mark-lead"
        role="img"
        aria-label={t('row.mark.aria')}
        title={t('row.mark.aria')}
        data-devlead-active-mark="true"
        data-devlead-row-mark="lead"
      >
        <IconSparkleRegular size={10} />
        <span className="devlead-row-mark-lead-label" aria-hidden="true">{t('row.mark.short')}</span>
      </span>
    )
  }
  if (!watched) return null
  return (
    <span
      className="devlead-row-mark devlead-row-mark-watched"
      role="img"
      aria-label={t('row.watched.aria')}
      data-devlead-row-mark="watched"
    >
      <IconGoalOutlineRegular size={13} />
    </span>
  )
}
