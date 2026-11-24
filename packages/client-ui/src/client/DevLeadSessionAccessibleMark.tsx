/**
 * Persistent screen-reader explanation for an active DevLead Session row.
 *
 * The visible badge lives in `sidebar.session.row.trailing`, which the shell
 * hides for hover, keyboard focus, and an open menu. This companion occupies
 * the leading seat with visually hidden text only, so those interactions do not
 * erase the row's lead fact from the accessibility tree. The seat itself is
 * replaced by a higher-priority status dot while a Session is active; the hover
 * card remains the supplementary explanation in that shell state.
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { devLeadRowEnabled, devLeadRowSummaryOf } from './sessionMark.ts'

/** Full props of the leading-seat accessibility companion. */
export type DevLeadSessionAccessibleMarkProps =
  PropsRuntime<'sidebar.session.row.leading'>
  & PropsLocale<'devlead'>

/**
 * Restate an enabled row's lead role without adding visible layout.
 * @param props.sessionId - Session this row shows.
 * @param props.useSessions - selector hook over the Session list store.
 * @param props.t - DevLead surface copy.
 * @returns visually hidden lead text, or nothing for a non-lead row.
 */
export function DevLeadSessionAccessibleMark({ sessionId, useSessions, t }: DevLeadSessionAccessibleMarkProps) {
  const enabled = useSessions((state: SessionListState) => devLeadRowEnabled(devLeadRowSummaryOf(state.byId, sessionId)))
  if (!enabled) return null
  return (
    <span className="devlead-sr-only" data-devlead-row-accessible="lead">
      {t('row.hover.enabled')}
    </span>
  )
}
