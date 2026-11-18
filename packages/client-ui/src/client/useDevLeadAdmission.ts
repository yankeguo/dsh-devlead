/**
 * The command-admission state machine behind the DevLead toolbar toggle.
 *
 * `DevLeadIconToggle` owns the single mode switch (on in the off state, off in
 * the on state). Its command behavior is: never flip state optimistically,
 * ignore a second click while one command is in flight, clear a stale failure
 * when the projection changes, and never touch React state after the surface
 * collapsed. The status-only `DevLeadBar` issues no commands and therefore
 * does not use this hook.
 *
 * The pure transitions (`devLeadAdmissionReducer`, `createDevLeadAdmissionGate`)
 * live in `results.ts` so they stay unit-testable without a renderer; this
 * module only binds them to React.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import {
  DEVLEAD_ADMISSION_IDLE,
  admitCommand,
  createDevLeadAdmissionGate,
  devLeadAdmissionReducer,
  type DevLeadCommandAdmission,
  type DevLeadCommandFailure,
} from './results.ts'

/** Admission face the toolbar toggle renders. */
export interface DevLeadAdmission {
  /** Whether the command is in flight; the surface disables its control while true. */
  readonly pending: boolean
  /** Failure of the last settled attempt, or null while none is shown. */
  readonly failure: DevLeadCommandFailure | null
  /**
   * Admit one `/devlead` line through the injected face.
   * @param line - full command line, leading slash included.
   */
  readonly run: (line: string) => void
}

/**
 * Bind the admission state machine to the toolbar toggle.
 *
 * `resetKey` is the projection's enabled flag: any mode change (from the
 * toggle, another client, or a `/devlead` command) invalidates feedback that
 * belonged to the previous attempt, while a rejected toggle leaves the flag
 * untouched so its error stays visible.
 * @param executeCommand - injected command face bound to the surface's Session.
 * @param resetKey - value whose change retires the previous attempt's failure.
 * @returns the in-flight flag, the last failure, and the admission callback.
 */
export function useDevLeadAdmission(
  executeCommand: (line: string) => Promise<DevLeadCommandAdmission>,
  resetKey: unknown,
): DevLeadAdmission {
  const [state, dispatch] = useReducer(devLeadAdmissionReducer, DEVLEAD_ADMISSION_IDLE)
  // One gate per mounted surface: it closes the same-render double-click window
  // that React state (which disables only on the next render) cannot.
  const [gate] = useState(createDevLeadAdmissionGate)
  // A command can outlive a slot collapse; the settle callback must not
  // dispatch into an unmounted surface.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  useEffect(() => {
    dispatch({ type: 'reset' })
  }, [resetKey])

  const run = (line: string): void => {
    if (!gate.tryEnter()) return
    dispatch({ type: 'begin' })
    void admitCommand(executeCommand, line).then((failure) => {
      gate.leave()
      if (!aliveRef.current) return
      dispatch({ type: 'settle', failure: failure ?? null })
    })
  }

  return { pending: state.pending, failure: state.failure, run }
}
