/**
 * DevLeadSessionHoverMark: the hover-card section that restates one Session
 * row's DevLead mark (`sidebar.session.row.hover`).
 *
 * The row's trailing seat is hidden by the shell while the row is hovered (that
 * is when the row's own actions take over), so the explanation of what the mark
 * means lives here: it mounts with the hover card and explains the active lead
 * or watched role. A plain row renders nothing.
 */

import { IconGoalOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { devLeadRowEnabled, devLeadRowWatched } from './sessionMark.ts'

/** Full props of the hover-card section: row identity + runtime hooks + copy. */
export type DevLeadSessionHoverMarkProps =
  PropsRuntime<'sidebar.session.row.hover'>
  & PropsLocale<'devlead'>

/**
 * Render the DevLead line of one Session row's hover card.
 * @param props.sessionId - Session this row shows.
 * @param props.useSessions - selector hook over the Session list store.
 * @param props.t - DevLead surface copy.
 * @returns the active/watched explanation line, or nothing for a plain row.
 */
export function DevLeadSessionHoverMark({ sessionId, useSessions, t }: DevLeadSessionHoverMarkProps) {
  // Same structural summary read as the row mark; the explicit selector
  // parameter type keeps the hook typed without the shell store package.
  const enabled = useSessions((state: SessionListState) => devLeadRowEnabled(state.byId[sessionId]))
  const watched = useSessions((state: SessionListState) => devLeadRowWatched(sessionId, state.byId))
  if (enabled) {
    return (
      <div className="devlead-row-hover" data-devlead-row-hover="true">
        <span className="devlead-row-hover-glyph" aria-hidden="true">
          <span className="devlead-row-hover-active-dot" />
        </span>
        <span>{t('row.hover.enabled')}</span>
      </div>
    )
  }
  if (!watched) return null
  return (
    <div className="devlead-row-hover" data-devlead-row-hover="true" data-devlead-row-watched="true">
      <span className="devlead-row-hover-glyph" aria-hidden="true">
        <IconGoalOutlineRegular size={14} />
      </span>
      <span>{t('row.hover.watched')}</span>
    </div>
  )
}
