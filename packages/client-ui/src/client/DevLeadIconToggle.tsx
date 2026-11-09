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
 * place and exposes the Host text through its tooltip.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconUsersOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { admitCommand, failureMessage, type DevLeadCommandFailure } from './results.ts'
import type { DevLeadCommandInjected } from './DevLeadBar.tsx'

/** Full props of the toolbar entry: runtime share + injected face + locale seat. */
export type DevLeadIconToggleProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<DevLeadCommandInjected>
  & PropsLocale<'devlead'>

/** The compact DevLead switch shown only while mode is disabled. */
export function DevLeadIconToggle({ useProjection, executeCommand, t }: DevLeadIconToggleProps) {
  const projection = useProjection('devLead')
  const enabled = projection?.enabled ?? false
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<DevLeadCommandFailure | null>(null)
  // React state disables the button on the next render; the ref closes the
  // same-render window so a rapid double click cannot admit two commands.
  const pendingRef = useRef(false)

  // Any mode change (from this button, the bar, or the /devlead command)
  // invalidates feedback that belonged to the previous attempt.
  useEffect(() => {
    setFailure(null)
  }, [enabled])

  if (projection === undefined || enabled) return null

  const enable = (): void => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setFailure(null)
    void admitCommand(executeCommand, '/devlead on').then((rejected) => {
      pendingRef.current = false
      setPending(false)
      if (rejected !== undefined) setFailure(rejected)
    })
  }

  const label = failure === null ? t('toggle.enable') : t('toggle.failed', { message: failureMessage(failure) })

  return (
    <Tooltip label={label} side="top" delayMs={300} maxWidth={300} portal>
      <Button
        variant="ghost"
        size="sm"
        className="devlead-toggle"
        aria-label={label}
        disabled={pending}
        data-devlead-toggle="true"
        data-devlead-pending={pending ? 'true' : 'false'}
        data-devlead-failed={failure === null ? 'false' : 'true'}
        onClick={enable}
      >
        <IconUsersOutlineRegular size={16} aria-hidden="true" />
      </Button>
    </Tooltip>
  )
}
