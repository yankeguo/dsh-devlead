/** Session-header entry that opens the read-only DevLead board tab. */
import { Button, IconFlatListOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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

export function DevLeadBoardButton({ onOpen, t }: DevLeadBoardButtonProps) {
  const label = t('board.open')
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
