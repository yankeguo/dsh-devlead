/** Session-header entry that opens the read-only DevLead board tab. */
import { Button, IconFlatListOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  currentDevLeadBoardConfig,
  resolveDevLeadBoardSessionConfig,
} from './board.ts'

/** Business face bound by the browser registration. */
export interface DevLeadBoardButtonInjected {
  readonly onOpen: () => void
}

/** Full Session-header slot props. */
export type DevLeadBoardButtonProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'devlead'>
  & InjectFace<DevLeadBoardButtonInjected>

/** Icon-only button; the tooltip and aria-label carry the localized name. */
export type DevLeadBoardTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'devlead'>

/** Live tab-chip title; unlike the open-time record it follows locale changes. */
export function DevLeadBoardTitle({ t }: DevLeadBoardTitleProps) {
  return t('board.title')
}

/**
 * Header action that opens the board tab. The registration is static so it can
 * come and go with the Session; the component itself renders nothing unless the
 * Session is an eligible lead (top-level, DevLead mode on, board path
 * resolvable). The hook runs in both branches so the render order is stable.
 */
export function DevLeadBoardButton({ onOpen, sessionId, useSessions, t }: DevLeadBoardButtonProps) {
  const visible = useSessions((snapshot: SessionListState): boolean =>
    resolveDevLeadBoardSessionConfig(sessionId, snapshot.byId[sessionId], currentDevLeadBoardConfig()) !== undefined)
  const label = t('board.open')
  if (!visible) return null
  return (
    <Tooltip label={label} side="bottom" delayMs={300} maxWidth={240} portal>
      <Button
        variant="ghost"
        size="sm"
        className="devlead-board-open"
        aria-label={label}
        data-devlead-board-open="true"
        onClick={onOpen}
      >
        <IconFlatListOutlineRegular size={16} />
      </Button>
    </Tooltip>
  )
}
