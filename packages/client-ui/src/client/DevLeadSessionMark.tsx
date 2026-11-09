/**
 * DevLeadSessionMark: the sidebar's DevLead marker for one Session row
 * (`sidebar.session.row.trailing`).
 *
 * The mark makes DevLead Sessions recognizable in the Session list instead of
 * only inside the open conversation. It renders only while the row's summary
 * reports DevLead mode enabled, reads the summary-sized `devLeadMode`
 * projection (never the digest), and activates, retains, or opens nothing: the
 * enclosing row keeps every cell as its activation area. The trailing seat is
 * hidden by the shell while the row is hovered or focused on hover-capable
 * devices; the same fact is restated in the row's hover card by
 * `DevLeadSessionHoverMark`.
 */

import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { devLeadRowEnabled } from './sessionMark.ts'

/** Full props of the row mark: row identity + runtime hooks + copy. */
export type DevLeadSessionMarkProps =
  PropsRuntime<'sidebar.session.row.trailing'>
  & PropsLocale<'devlead'>

/**
 * Render the DevLead mark for an enabled Session row.
 * @param props.sessionId - Session this row shows.
 * @param props.useSessions - selector hook over the Session list store.
 * @param props.t - DevLead surface copy.
 * @returns the mark, or nothing while the row reports mode disabled.
 */
export function DevLeadSessionMark({ sessionId, useSessions, t }: DevLeadSessionMarkProps) {
  // The explicit parameter type keeps this component typed even in a workspace
  // that does not install the shell store package that declares the hook shape.
  const enabled = useSessions((state: SessionListState) => devLeadRowEnabled(state.byId[sessionId]))
  if (!enabled) return null
  return (
    <span
      className="devlead-row-mark"
      role="img"
      aria-label={t('row.mark.aria')}
      data-devlead-row-mark="true"
    >
      <IconShieldOutlineRegular size={13} />
    </span>
  )
}
