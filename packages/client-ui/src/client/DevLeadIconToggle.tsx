/**
 * DevLeadIconToggle: the off-state DevLead switch in the composer toolbar
 * (`conversation.input.left`).
 *
 * The dock strip renders only while mode is enabled, so this small ghost icon
 * button is the human entry point that turns it on: it sits beside the existing
 * composer controls, keeps no permanent bar in every conversation, and
 * disappears once the full DevLeadBar is on screen.
 *
 * The button reads the `devLead` projection and never flips optimistically; a
 * click executes the Host `/devlead on` command. A failure keeps the button in
 * place and exposes the Host text through its tooltip, and a visually hidden
 * live region announces the same failure to assistive technology because this
 * compact toolbar surface has no inline error row.
 */

import { Button, IconUsersOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVLEAD_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import { failureMessage } from './results.ts'
import type { DevLeadCommandInjected } from './DevLeadBar.tsx'
import { useDevLeadAdmission } from './useDevLeadAdmission.ts'

/** Full props of the toolbar entry: runtime share + injected face + locale seat. */
export type DevLeadIconToggleProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<DevLeadCommandInjected>
  & PropsLocale<'devlead'>

/** The compact DevLead switch shown only while mode is disabled. */
export function DevLeadIconToggle({ useProjection, executeCommand, t }: DevLeadIconToggleProps) {
  const projection = useProjection(DEVLEAD_PROJECTION_KEY)
  const enabled = projection?.enabled ?? false
  const { pending, failure, run } = useDevLeadAdmission(executeCommand, enabled)

  if (projection === undefined || enabled) return null

  const label = failure === null ? t('toggle.enable') : t('toggle.failed', { message: failureMessage(failure) })

  return (
    <>
      <Tooltip label={label} side="top" delayMs={300} maxWidth={300} portal>
        <Button
          variant="ghost"
          size="sm"
          className="devlead-toggle"
          aria-label={label}
          aria-busy={pending}
          disabled={pending}
          data-devlead-toggle="true"
          data-devlead-pending={pending ? 'true' : 'false'}
          data-devlead-failed={failure === null ? 'false' : 'true'}
          onClick={() => {
            run('/devlead on')
          }}
        >
          <IconUsersOutlineRegular size={16} />
        </Button>
      </Tooltip>
      {/* The tooltip is the only visible failure seat here (hover/focus only).
          The live region stays mounted and changes its text when a failure
          settles, so screen readers announce the change reliably. */}
      <span className="devlead-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {failure === null ? null : t('toggle.failed.status', { message: failureMessage(failure) })}
      </span>
    </>
  )
}
