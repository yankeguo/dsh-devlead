/**
 * DevLeadIconToggle: the single DevLead mode switch in the composer toolbar
 * (`conversation.input.left`).
 *
 * The button is mounted whenever the `devLead` projection is loaded, in both
 * states. With the mode off it submits `/devlead on`; with the mode on it
 * submits `/devlead off`. It therefore stays in place while the enabled-only
 * DevLeadBar appears and disappears above the composer — the status strip owns
 * no switch, so turning the mode off cannot hide the control that did it.
 *
 * The button carries both the users icon and a visible localized `DevLead`
 * label, so the toolbar entry explains itself without relying on hover alone.
 *
 * State is read from the projection and never flipped optimistically. A click
 * runs the Host command through the injected face; pending disables the button
 * and is exposed through `aria-busy`. A failure keeps the button in place and
 * exposes the Host text through its tooltip, aria-label, and a visually hidden
 * live region that announces the same text to assistive technology. The
 * tooltip also opens on click while a failure is showing, so a touch user can
 * read the full message (the button runs the idempotent command again).
 */

import { useState } from 'react'
import { Button, IconUsersOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVLEAD_COMMAND_NAME, DEVLEAD_PROJECTION_KEY } from '@yankeguo/dsh-devlead-protocol/client'
import { failureMessage, type DevLeadCommandAdmission } from './results.ts'
import { useDevLeadAdmission } from './useDevLeadAdmission.ts'

/** Injected business face of the toolbar entry: command admission. */
export interface DevLeadCommandInjected {
  /**
   * Execute one `/devlead` line against the surface's Session.
   * @param line - the full command line, leading slash included.
   * @returns the Host admission result.
   */
  readonly executeCommand: (line: string) => Promise<DevLeadCommandAdmission>
}

/** Full props of the toolbar entry: runtime share + injected face + locale seat. */
export type DevLeadIconToggleProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<DevLeadCommandInjected>
  & PropsLocale<'devlead'>

/** Direction one toggle click requests; also selects the failure copy. */
type ToggleDirection = 'on' | 'off'

/** The compact DevLead switch shown in both mode states. */
export function DevLeadIconToggle({ useProjection, executeCommand, t }: DevLeadIconToggleProps) {
  const projection = useProjection(DEVLEAD_PROJECTION_KEY)
  const enabled = projection?.enabled ?? false
  const { pending, failure, run } = useDevLeadAdmission(executeCommand, enabled)
  // The settled failure belongs to the direction of the last click. A
  // successful toggle flips `enabled`, which resets the failure, so this only
  // matters while a rejected command left the mode unchanged.
  const [attempt, setAttempt] = useState<ToggleDirection>('on')

  if (projection === undefined) return null

  const direction: ToggleDirection = enabled ? 'off' : 'on'
  const failureText = failure === null ? null : failureMessage(failure, t)
  const actionLabel = enabled ? t('toggle.disable') : t('toggle.enable')
  const failureLabel = failureText === null
    ? null
    : t(
        attempt === 'off' ? 'toggle.failed.disable' : 'toggle.failed',
        { message: failureText },
      )
  const label = failureLabel ?? (pending ? t('toggle.pending') : actionLabel)
  const status = failureText === null
    ? null
    : t(
        attempt === 'off' ? 'toggle.failed.status.disable' : 'toggle.failed.status',
        { message: failureText },
      )

  return (
    <>
      <Tooltip
        label={label}
        side="top"
        delayMs={300}
        maxWidth={300}
        portal
        openOnClick={failure !== null}
      >
        <Button
          variant="ghost"
          size="sm"
          className="devlead-toggle"
          aria-label={label}
          aria-busy={pending}
          aria-pressed={enabled}
          disabled={pending}
          data-devlead-toggle="true"
          data-devlead-enabled={enabled ? 'true' : 'false'}
          data-devlead-pending={pending ? 'true' : 'false'}
          data-devlead-failed={failure === null ? 'false' : 'true'}
          onClick={() => {
            setAttempt(direction)
            run(`/${DEVLEAD_COMMAND_NAME} ${direction}`)
          }}
        >
          <IconUsersOutlineRegular size={16} />
          <span className="devlead-toggle-label">{t('toggle.label')}</span>
        </Button>
      </Tooltip>
      {/* The tooltip is the only visible failure seat here (hover/focus only).
          The live region stays mounted and changes its text when a failure
          settles, so screen readers announce the change reliably. */}
      <span className="devlead-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </span>
    </>
  )
}
