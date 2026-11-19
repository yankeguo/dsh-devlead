/**
 * Render tests for the DevLead client surfaces.
 *
 * The package is a browser plugin, yet none of these components touches the
 * DOM: the slot runtime injects every data source as a props seat, and the one
 * primitive dependency is mocked below with minimal stand-ins. React 18's
 * `react-test-renderer` (with `act`) therefore keeps the suite in plain Node —
 * no jsdom — while still exercising the real hooks, effects, and render
 * branches.
 *
 * What each surface and the shared admission hook must guarantee:
 * - the enabled strip is status-only: no switch or other command control, but
 *   counts and the live notification region;
 * - the toolbar toggle renders in both mode states, submits `/devlead on` or
 *   `/devlead off`, exposes pending through disabled/aria-busy, and reports
 *   failures through its label, tooltip, and a visually hidden live
 *   region;
 * - one in-flight command cannot be admitted twice, a settle after unmount is
 *   ignored, and a mode change retires stale feedback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import {
  DEVLEAD_MODE_PROJECTION_KEY,
  DEVLEAD_WATCH_PROJECTION_KEY,
  notificationLine,
  reportLine,
} from '@yankeguo/dsh-devlead-protocol/client'
import type { DevLeadNotification, DevLeadProjection, DevLeadReport } from '@yankeguo/dsh-devlead-protocol/client'
import { DevLeadBar, type DevLeadBarProps } from '../src/client/DevLeadBar.tsx'
import {
  DevLeadIconToggle,
  type DevLeadCommandInjected,
  type DevLeadIconToggleProps,
} from '../src/client/DevLeadIconToggle.tsx'
import {
  DevLeadSessionHoverMark,
  type DevLeadSessionHoverMarkProps,
} from '../src/client/DevLeadSessionHoverMark.tsx'
import {
  DevLeadSessionMark,
  type DevLeadSessionMarkProps,
} from '../src/client/DevLeadSessionMark.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { DevLeadCommandAdmission } from '../src/client/results.ts'
import { useDevLeadAdmission } from '../src/client/useDevLeadAdmission.ts'

// React 18 only runs updates through act() quietly when the renderer is told it
// is inside a test environment; Node has no jsdom to set that flag for us.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * Minimal stand-ins for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The surfaces own behavior, not primitive visuals: the mock forwards exactly
 * the attributes and callbacks a surface binds, so assertions read the same DOM
 * surface a browser would render. Native host elements also let the test drive
 * real event handlers instead of calling component internals.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  /** Native button forwarding every attribute the toolbar surface binds. */
  const Button = ({ children, ...rest }: {
    readonly children?: ReactNode
    readonly className?: string
    readonly disabled?: boolean
    readonly onClick?: () => void
    readonly 'aria-label'?: string
    readonly 'aria-busy'?: boolean
    readonly 'data-devlead-toggle'?: string
    readonly 'data-devlead-pending'?: string
    readonly 'data-devlead-failed'?: string
  }) => <button {...rest}>{children}</button>

  /** Tooltip renders its anchor and exposes the label it was asked to show. */
  const Tooltip = ({ label, openOnClick, children }: {
    readonly label?: string
    readonly openOnClick?: boolean
    readonly children?: ReactNode
  }) => <span data-mock-tooltip={label} data-mock-open-on-click={openOnClick === true ? 'true' : 'false'}>{children}</span>

  /** Both surface glyphs render as an inert span. */
  const Icon = () => <span data-mock-icon="true" aria-hidden="true" />

  return {
    Button,
    Tooltip,
    IconGoalOutlineRegular: Icon,
    IconUsersOutlineRegular: Icon,
  }
})

/** Successful Host admission of one `/devlead` line. */
const SUCCESS: DevLeadCommandAdmission = { ok: true, value: { result: { kind: 'success' } } }

/** Command face that admits every line successfully. */
async function succeed(): Promise<DevLeadCommandAdmission> {
  return SUCCESS
}

/** One command admission that the test settles explicitly. */
interface DeferredAdmission {
  /** Admission promise handed to the surface under test. */
  readonly promise: Promise<DevLeadCommandAdmission>
  /** Settle the in-flight admission. */
  readonly resolve: (admission: DevLeadCommandAdmission) => void
}

/**
 * Create an admission promise whose settlement the test controls, so in-flight
 * state can be asserted before it settles.
 * @returns the promise plus its settle function.
 */
function deferredAdmission(): DeferredAdmission {
  let resolve!: (admission: DevLeadCommandAdmission) => void
  const promise = new Promise<DevLeadCommandAdmission>((settlePromise) => {
    resolve = settlePromise
  })
  return { promise, resolve }
}

/**
 * Build a translate function from a real shipped dictionary.
 *
 * The surfaces consume only the framework-injected `t` seat; reproducing the
 * locale runtime's `{name}` interpolation keeps the rendered copy identical to
 * the shipped zh/en text.
 * @param dictionary - namespace dictionary from `locales.ts`.
 * @returns the namespace-bound translate stand-in.
 */
function translate(
  dictionary: Record<string, string>,
): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) =>
    (dictionary[key] ?? key).replace(/\{([a-z]+)\}/gu, (placeholder, name: string) => {
      const value = params?.[name]
      return value === undefined ? placeholder : String(value)
    })
}

/** Real zh copy the surfaces render in these tests. */
const t = translate(zh)

/** One retained notification fixture; the strip shows the latest one. */
const NOTIFICATION: DevLeadNotification = {
  id: 'session-b:2:completed',
  sessionId: 'session-b',
  sessionTitle: 'Ship the parser',
  transition: 'completed',
  turn: 2,
  at: Date.UTC(2026, 0, 5, 12, 0, 0),
}

/** Projection of an enabled Session with no retained notification yet. */
const ENABLED_PROJECTION: DevLeadProjection = {
  enabled: true,
  sessions: [],
  notifications: [],
  reports: [],
}

/** Projection of a disabled Session. */
const DISABLED_PROJECTION: DevLeadProjection = {
  enabled: false,
  sessions: [],
  notifications: [],
  reports: [],
}

/** Session-list rows keyed by id; tests provide only the summary facts read. */
type TestRows = Readonly<Record<string, unknown>>

/** Per-Session UI statuses; tests provide only the running fact read. */
type TestStatuses = ReadonlyMap<string, { readonly running: boolean | undefined }>

/** Per-test inputs for the slot props a DevLead surface normally receives. */
interface SurfaceFakes {
  /** Current `devLead` projection value; undefined means the seat carries none. */
  readonly projection?: DevLeadProjection | undefined
  /** Session-list rows the `useSessions` selector reads. */
  readonly rows?: TestRows
  /** Per-Session UI statuses the `useSessionStatus` selector reads. */
  readonly statuses?: TestStatuses
  /** Session identity this surface renders for. */
  readonly sessionId?: string
  /** Injected command-admission face. */
  readonly executeCommand?: DevLeadCommandInjected['executeCommand']
  /** Locale translate seat. */
  readonly t?: (key: string, params?: Record<string, unknown>) => string
}

/**
 * Compose the framework-provided slot props from test fakes.
 *
 * The real seats come from the Session standard kit, the global selector hooks,
 * and the locale binding. These tests supply structural fakes for the seats a
 * surface reads and cast once at this seam; the behavior under test is the
 * surface's, not the slot runtime's.
 * @param fakes - per-test inputs.
 * @returns the fake slot props.
 */
function surfaceProps(fakes: SurfaceFakes): Record<string, unknown> {
  return {
    sessionId: fakes.sessionId ?? 'session-1',
    useProjection: () => fakes.projection,
    useSessions: (selector: (state: SessionListState) => unknown) =>
      selector({ byId: fakes.rows ?? {} } as unknown as SessionListState),
    // Symmetric with useSessions: apply the component's selector so a changed
    // selector shape fails the test instead of silently reading the raw map.
    useSessionStatus: (selector: (snapshot: SessionStatusSnapshot) => unknown) =>
      selector((fakes.statuses ?? new Map()) as unknown as SessionStatusSnapshot),
    executeCommand: fakes.executeCommand ?? succeed,
    t: fakes.t ?? t,
  }
}

/**
 * Props of the enabled strip for one test input.
 * @param fakes - per-test inputs.
 * @returns the composed component props.
 */
function barProps(fakes: SurfaceFakes): DevLeadBarProps {
  return surfaceProps(fakes) as unknown as DevLeadBarProps
}

/**
 * Props of the both-state toolbar toggle for one test input.
 * @param fakes - per-test inputs.
 * @returns the composed component props.
 */
function toggleProps(fakes: SurfaceFakes): DevLeadIconToggleProps {
  return surfaceProps(fakes) as unknown as DevLeadIconToggleProps
}

/**
 * Props of the Session-row mark for one test input.
 * @param fakes - per-test inputs.
 * @returns the composed component props.
 */
function markProps(fakes: SurfaceFakes): DevLeadSessionMarkProps {
  return surfaceProps(fakes) as unknown as DevLeadSessionMarkProps
}

/**
 * Props of the hover-card explanation line for one test input.
 * @param fakes - per-test inputs.
 * @returns the composed component props.
 */
function hoverMarkProps(fakes: SurfaceFakes): DevLeadSessionHoverMarkProps {
  return surfaceProps(fakes) as unknown as DevLeadSessionHoverMarkProps
}

/** Renderers mounted by the current test, unmounted before the next one. */
const mounted: ReactTestRenderer[] = []

/**
 * Render one element and keep the renderer for the afterEach sweep.
 * @param element - element to mount.
 * @returns the test renderer.
 */
async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(element)
  })
  if (renderer === undefined) throw new Error('react-test-renderer created no renderer')
  mounted.push(renderer)
  return renderer
}

/**
 * Unmount one renderer inside `act` and drop it from the afterEach sweep.
 * @param renderer - mounted renderer.
 */
async function unmount(renderer: ReactTestRenderer): Promise<void> {
  mounted.splice(mounted.indexOf(renderer), 1)
  await act(async () => {
    renderer.unmount()
  })
}

/**
 * Run one rendered handler inside `act` and drain the admission promise chain.
 *
 * The chain (`run → admitCommand → command face → classify → settle`) crosses
 * one microtask per `await`; the explicit yields keep the tests timer-free and
 * independent of React's internal act-queue flushing.
 * @param handler - rendered event handler to invoke.
 */
async function settle(handler: () => void): Promise<void> {
  await act(async () => {
    handler()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * Text of one rendered subtree, as a browser would expose it.
 * @param instance - rendered instance.
 * @returns concatenated text nodes.
 */
function textOf(instance: ReactTestInstance): string {
  return instance.children
    .map(child => (typeof child === 'string' ? child : textOf(child)))
    .join('')
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.restoreAllMocks()
})

describe('DevLeadBar', () => {
  it('renders nothing without a projection or while mode is disabled', async () => {
    const absent = await mount(<DevLeadBar {...barProps({ projection: undefined })} />)
    expect(absent.toJSON()).toBeNull()
    const disabled = await mount(
      <DevLeadBar {...barProps({ projection: DISABLED_PROJECTION })} />,
    )
    expect(disabled.toJSON()).toBeNull()
  })

  it('renders the enabled strip as status-only: label, counts, and help hint', async () => {
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-a', 'session-b', 'session-c'],
      notifications: [],
      reports: [],
    }
    const renderer = await mount(
      <DevLeadBar
        {...barProps({
          projection,
          // session-a runs in the catalog; session-b's live UI status outranks
          // its stale catalog row and reports it running; session-c left the
          // catalog and must still count as watched-but-unavailable.
          rows: { 'session-a': { running: true }, 'session-b': { running: false } },
          statuses: new Map([['session-b', { running: true }]]),
        })}
      />,
    )

    const dock = renderer.root.findByProps({ 'data-devlead-bar': 'true' })
    expect(dock.props['data-devlead-enabled']).toBe('true')
    // The old strip carried a pending flag for its switch; a status strip that
    // issues no command must not expose one.
    expect(dock.props['data-devlead-pending']).toBeUndefined()
    const bar = renderer.root.findByProps({ className: 'devlead-bar' })
    expect(bar.props['role']).toBe('group')
    expect(bar.props['aria-label']).toBe(zh['bar.aria'])
    expect(bar.props['aria-busy']).toBeUndefined()

    expect(textOf(renderer.root.findByProps({ className: 'devlead-watched' }))).toBe(
      t('count.watched', { count: 3 }),
    )
    expect(textOf(renderer.root.findByProps({ className: 'devlead-running' }))).toBe(
      t('count.running', { count: 2 }),
    )
    expect(textOf(renderer.root.findByProps({ className: 'devlead-missing' }))).toBe(
      t('count.missing', { count: 1 }),
    )

    // The strip owns no mode switch: the only control lives in the composer
    // toolbar and must stay visible when the strip comes and goes.
    expect(renderer.root.findAllByType('input')).toHaveLength(0)
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'devlead-switch' })).toHaveLength(0)

    // No retained notification yet: the strip keeps the help hint visible in
    // its polite live region instead of leaving the row visually empty.
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    expect(notice.props['role']).toBe('status')
    expect(notice.props['aria-live']).toBe('polite')
    expect(notice.props['aria-atomic']).toBe('true')
    expect(textOf(notice)).toBe(zh['hint.enabled'])
    expect(renderer.root.findAllByProps({ className: 'devlead-hint' })).toHaveLength(1)
  })

  it('renders the latest retained notification in the live region', async () => {
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [NOTIFICATION],
      reports: [],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    const text = textOf(notice)
    expect(text).toContain('Ship the parser')
    expect(text).toContain(t('notification.turn', { turn: 2 }))
    expect(text).toContain(zh['transition.completed'])
    // The chip's technical tooltip is the canonical Host digest line.
    expect(notice.props['title']).toBe(notificationLine(NOTIFICATION))
    expect(renderer.root.findAllByProps({ className: 'devlead-hint' })).toHaveLength(0)
  })

  it('renders a completed notification assistant summary as neutral detail', async () => {
    const withSummary: DevLeadNotification = { ...NOTIFICATION, summary: 'implemented the parser' }
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [withSummary],
      reports: [],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    expect(textOf(notice)).toContain('implemented the parser')
    // The assistant excerpt is neutral copy; only a real failure excerpt wears
    // the error ink.
    expect(renderer.root.findByProps({ className: 'devlead-notification-detail' })).toBeDefined()
    expect(renderer.root.findAllByProps({ className: 'devlead-notification-error' })).toHaveLength(0)
    expect(notice.props['title']).toBe(notificationLine(withSummary))
  })

  it('prefers a real failure excerpt over the assistant summary', async () => {
    const failed: DevLeadNotification = {
      ...NOTIFICATION,
      transition: 'error',
      error: 'provider quota exhausted',
      summary: 'tried the fix',
    }
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [failed],
      reports: [],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    const text = textOf(notice)
    expect(text).toContain('provider quota exhausted')
    expect(text).not.toContain('tried the fix')
    expect(renderer.root.findByProps({ className: 'devlead-notification-error' })).toBeDefined()
    expect(renderer.root.findAllByProps({ className: 'devlead-notification-detail' })).toHaveLength(0)
  })

  it('renders the enabled strip when the projection collections are unusable', async () => {
    // Wire/version drift: the collections are missing entirely. The dock must
    // degrade to zero counts and the help hint instead of throwing through the
    // composer subtree.
    const drifted = {
      enabled: true,
      sessions: undefined,
      notifications: undefined,
      reports: undefined,
    } as unknown as DevLeadProjection
    const renderer = await mount(<DevLeadBar {...barProps({ projection: drifted })} />)
    const bar = renderer.root.findByProps({ className: 'devlead-bar' })
    expect(bar.props['role']).toBe('group')
    expect(textOf(renderer.root.findByProps({ className: 'devlead-watched' })))
      .toBe(t('count.watched', { count: 0 }))
    expect(textOf(renderer.root.findByProps({ className: 'devlead-running' })))
      .toBe(t('count.running', { count: 0 }))
    expect(renderer.root.findAllByProps({ className: 'devlead-missing' })).toHaveLength(0)
    expect(textOf(renderer.root.findByProps({ className: 'devlead-notice' }))).toBe(zh['hint.enabled'])
  })

  it('renders the newest report with sender, kind, and summary', async () => {
    const report: DevLeadReport = {
      id: 'session-b:2:report:blocked:abc',
      kind: 'blocked',
      message: 'waiting for credentials',
      summary: 'credential blocker',
      senderSessionId: 'session-b',
      senderSessionTitle: 'Ship the parser',
      leadSessionId: 'lead-1',
      turn: 2,
      at: NOTIFICATION.at + 1,
    }
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [NOTIFICATION],
      reports: [report],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    const text = textOf(notice)
    expect(text).toContain('Ship the parser')
    expect(text).toContain(zh['report.kind.blocked'])
    expect(text).toContain('credential blocker')
    expect(text).not.toContain(zh['transition.completed'])
    expect(notice.props['title']).toBe(reportLine(report))
    expect(renderer.root.findByProps({ 'data-report-kind': 'blocked' })).toBeDefined()
    // Report detail is neutral copy, not a failure excerpt: the kind dot and
    // label carry the semantics, the text must not wear the error ink.
    expect(renderer.root.findByProps({ className: 'devlead-notification-detail' })).toBeDefined()
    expect(renderer.root.findAllByProps({ className: 'devlead-notification-error' })).toHaveLength(0)
  })

  it('keeps a newer turn notification ahead of an older report', async () => {
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [NOTIFICATION],
      reports: [{
        id: 'session-b:2:report:progress:abc',
        kind: 'progress',
        message: 'earlier update',
        senderSessionId: 'session-b',
        leadSessionId: 'lead-1',
        turn: 2,
        at: NOTIFICATION.at - 1,
      }],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const text = textOf(renderer.root.findByProps({ className: 'devlead-notice' }))
    expect(text).toContain(zh['transition.completed'])
    expect(text).not.toContain(zh['report.kind.progress'])
  })

  it('lets a report win an exact instant tie with the latest notification', async () => {
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [NOTIFICATION],
      reports: [{
        id: 'session-b:2:report:question:abc',
        kind: 'question',
        message: 'which branch should I target?',
        senderSessionId: 'session-b',
        leadSessionId: 'lead-1',
        turn: 2,
        at: NOTIFICATION.at,
      }],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const text = textOf(renderer.root.findByProps({ className: 'devlead-notice' }))
    expect(text).toContain(zh['report.kind.question'])
    expect(text).not.toContain(zh['transition.completed'])
  })

  it('keeps a real notification ahead of a report whose drifted instant sanitizes to 0', async () => {
    // Wire drift: missing message, non-string summary, non-finite instant.
    // The strip must degrade instead of crashing, and the sanitized instant
    // (0) must lose to the notification's real instant rather than poisoning
    // the comparison (`NaN >= x` is always false, but so is `x >= NaN`).
    const drifted = {
      id: 'session-b:2:report:progress:abc',
      kind: 'progress',
      summary: 42,
      senderSessionId: 'session-b',
      leadSessionId: 'lead-1',
      turn: 2,
      at: Number.NaN,
    } as unknown as DevLeadReport
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [NOTIFICATION],
      reports: [drifted],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const text = textOf(renderer.root.findByProps({ className: 'devlead-notice' }))
    expect(text).toContain(zh['transition.completed'])
    expect(text).not.toContain(zh['report.kind.progress'])
  })

  it('renders a lone drifted report with a degraded tooltip instead of crashing', async () => {
    const drifted = {
      id: 'session-b:2:report:progress:abc',
      kind: 'progress',
      summary: 42,
      senderSessionId: 'session-b',
      leadSessionId: 'lead-1',
      turn: 2,
      at: Number.NaN,
    } as unknown as DevLeadReport
    const projection: DevLeadProjection = {
      enabled: true,
      sessions: ['session-b'],
      notifications: [],
      reports: [drifted],
    }
    const renderer = await mount(<DevLeadBar {...barProps({ projection })} />)
    const notice = renderer.root.findByProps({ className: 'devlead-notice' })
    expect(textOf(notice)).toContain('session-b')
    expect(textOf(notice)).toContain(zh['report.kind.progress'])
    // The canonical protocol line tolerates the same drift (no message, a
    // non-string summary): bare sender id, kind label, no detail suffix.
    expect(notice.props['title']).toBe('session-b — report progress')
    expect(renderer.root.findAllByProps({ className: 'devlead-notification-detail' })).toHaveLength(0)
  })

  it('renders the English dictionary through the same injected t seat', async () => {
    const renderer = await mount(
      <DevLeadBar {...barProps({ projection: ENABLED_PROJECTION, t: translate(en) })} />,
    )
    const bar = renderer.root.findByProps({ className: 'devlead-bar' })
    expect(bar.props['aria-label']).toBe(en['bar.aria'])
    expect(textOf(renderer.root.findByProps({ className: 'devlead-notice' }))).toBe(
      en['hint.enabled'],
    )
  })

})

describe('DevLeadIconToggle', () => {
  it('renders nothing without a projection', async () => {
    const absent = await mount(<DevLeadIconToggle {...toggleProps({ projection: undefined })} />)
    expect(absent.toJSON()).toBeNull()
  })

  it('renders the off-state button and turns mode on when clicked', async () => {
    const executeCommand = vi.fn(async () => SUCCESS)
    const renderer = await mount(
      <DevLeadIconToggle
        {...toggleProps({ projection: DISABLED_PROJECTION, executeCommand })}
      />,
    )

    const button = renderer.root.findByType('button')
    expect(textOf(button)).toContain(zh['toggle.label'])
    expect(button.props['aria-label']).toBe(zh['toggle.enable'])
    expect(button.props['aria-pressed']).toBe(false)
    expect(button.props['aria-busy']).toBe(false)
    expect(button.props['data-devlead-toggle']).toBe('true')
    expect(button.props['data-devlead-enabled']).toBe('false')
    expect(button.props['data-devlead-failed']).toBe('false')
    expect(renderer.root.findByProps({ 'data-mock-tooltip': zh['toggle.enable'] })).toBeDefined()
    // The compact toolbar has no inline error seat: the live region is mounted
    // from the start and announces a later change.
    expect(textOf(renderer.root.findByProps({ role: 'status' }))).toBe('')

    await settle(() => {
      button.props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('/devlead on')
    expect(renderer.root.findByType('button').props['data-devlead-pending']).toBe('false')
  })

  it('stays rendered in the on state and turns mode off when clicked', async () => {
    const executeCommand = vi.fn(async () => SUCCESS)
    const renderer = await mount(
      <DevLeadIconToggle
        {...toggleProps({ projection: ENABLED_PROJECTION, executeCommand })}
      />,
    )

    const button = renderer.root.findByType('button')
    expect(textOf(button)).toContain(zh['toggle.label'])
    expect(button.props['aria-label']).toBe(zh['toggle.disable'])
    expect(button.props['aria-pressed']).toBe(true)
    expect(button.props['aria-busy']).toBe(false)
    expect(button.props['data-devlead-enabled']).toBe('true')
    expect(button.props['data-devlead-failed']).toBe('false')
    expect(renderer.root.findByProps({ 'data-mock-tooltip': zh['toggle.disable'] })).toBeDefined()
    expect(textOf(renderer.root.findByProps({ role: 'status' }))).toBe('')

    await settle(() => {
      button.props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('/devlead off')
    expect(renderer.root.findByType('button').props['data-devlead-pending']).toBe('false')
  })

  it.each([
    ['on', DISABLED_PROJECTION, '/devlead on'],
    ['off', ENABLED_PROJECTION, '/devlead off'],
  ] as const)('disables the button and shows pending copy while a %s command is in flight', async (
    _direction, projection, line,
  ) => {
    const command = deferredAdmission()
    const executeCommand = vi.fn(() => command.promise)
    const renderer = await mount(
      <DevLeadIconToggle {...toggleProps({ projection, executeCommand })} />,
    )
    await settle(() => {
      renderer.root.findByType('button').props['onClick']()
    })

    expect(executeCommand).toHaveBeenCalledWith(line)
    const pending = renderer.root.findByType('button')
    expect(pending.props['aria-busy']).toBe(true)
    expect(pending.props['aria-label']).toBe(zh['toggle.pending'])
    expect(pending.props['disabled']).toBe(true)
    expect(pending.props['data-devlead-pending']).toBe('true')

    command.resolve(SUCCESS)
    await settle(() => {})
    const settled = renderer.root.findByType('button')
    expect(settled.props['aria-busy']).toBe(false)
    expect(settled.props['disabled']).toBe(false)
  })

  it('reports a failed on attempt through the label, tooltip, and hidden live region', async () => {
    const executeCommand = vi.fn(async (): Promise<DevLeadCommandAdmission> => {
      throw new Error('carrier lost')
    })
    const renderer = await mount(
      <DevLeadIconToggle
        {...toggleProps({ projection: DISABLED_PROJECTION, executeCommand })}
      />,
    )
    await settle(() => {
      renderer.root.findByType('button').props['onClick']()
    })

    const button = renderer.root.findByType('button')
    const label = t('toggle.failed', { message: 'carrier lost' })
    expect(button.props['data-devlead-failed']).toBe('true')
    expect(button.props['aria-label']).toBe(label)
    expect(renderer.root.findByProps({ 'data-mock-tooltip': label })).toBeDefined()
    // A failure is readable on touch too: the tooltip is pinned on click while
    // the message is showing.
    expect(renderer.root.findByProps({ 'data-mock-tooltip': label }).props['data-mock-open-on-click']).toBe('true')
    expect(textOf(renderer.root.findByProps({ role: 'status' }))).toBe(
      t('toggle.failed.status', { message: 'carrier lost' }),
    )
    // A settled failure must not leave the control disabled: retrying is the
    // whole point of keeping the button in place.
    expect(button.props['disabled']).toBe(false)
  })

  it('reports a failed off attempt with the off copy and keeps the control retryable', async () => {
    const executeCommand = vi.fn(async (): Promise<DevLeadCommandAdmission> => {
      throw new Error('carrier lost')
    })
    const renderer = await mount(
      <DevLeadIconToggle
        {...toggleProps({ projection: ENABLED_PROJECTION, executeCommand })}
      />,
    )
    await settle(() => {
      renderer.root.findByType('button').props['onClick']()
    })

    const button = renderer.root.findByType('button')
    const label = t('toggle.failed.disable', { message: 'carrier lost' })
    expect(executeCommand).toHaveBeenCalledWith('/devlead off')
    expect(button.props['data-devlead-failed']).toBe('true')
    expect(button.props['data-devlead-enabled']).toBe('true')
    expect(button.props['aria-label']).toBe(label)
    expect(renderer.root.findByProps({ 'data-mock-tooltip': label })).toBeDefined()
    // A failure is readable on touch too: the tooltip is pinned on click while
    // the message is showing.
    expect(renderer.root.findByProps({ 'data-mock-tooltip': label }).props['data-mock-open-on-click']).toBe('true')
    expect(textOf(renderer.root.findByProps({ role: 'status' }))).toBe(
      t('toggle.failed.status.disable', { message: 'carrier lost' }),
    )
    expect(button.props['disabled']).toBe(false)

    // The mode never left the projection's enabled state, so a retry still
    // submits the off command.
    await settle(() => {
      renderer.root.findByType('button').props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand).toHaveBeenLastCalledWith('/devlead off')
  })
})

describe('DevLeadSessionMark', () => {
  it('renders only the accessible active status hook, with no trailing glyph', async () => {
    const rows: TestRows = {
      'session-1': { projectionValues: { [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: true } } },
    }
    const renderer = await mount(<DevLeadSessionMark {...markProps({ rows })} />)
    const status = renderer.root.findByProps({ 'data-devlead-active-mark': 'true' })
    expect(status.props['role']).toBe('img')
    expect(status.props['aria-label']).toBe(zh['row.mark.aria'])
    expect(status.props.className).toContain('devlead-sr-only')
    expect(renderer.root.findAllByProps({ 'data-mock-icon': 'true' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-devlead-row-mark': 'watched' })).toHaveLength(0)
  })

  it('renders a quieter watched mark for a row listed by the active lead', async () => {
    const rows: TestRows = {
      'lead-1': {
        projectionValues: {
          [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: true },
          [DEVLEAD_WATCH_PROJECTION_KEY]: { sessions: ['session-1'] },
        },
      },
      'session-1': { projectionValues: { [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: false } } },
    }
    const renderer = await mount(<DevLeadSessionMark {...markProps({ rows })} />)
    const mark = renderer.root.findByProps({ 'data-devlead-row-mark': 'watched' })
    expect(mark.props['role']).toBe('img')
    expect(mark.props['aria-label']).toBe(zh['row.watched.aria'])
    expect(mark.props.className).toContain('devlead-row-mark-watched')
    expect(renderer.root.findAllByProps({ 'data-devlead-active-mark': 'true' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-mock-icon': 'true' })).toHaveLength(1)
  })

  it('does not mark a plain unwatched row', async () => {
    const rows: TestRows = {
      'session-1': { projectionValues: { [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: false } } },
    }
    const renderer = await mount(<DevLeadSessionMark {...markProps({ rows })} />)
    expect(renderer.toJSON()).toBeNull()
  })

  it('renders nothing while the row carries no DevLead summary', async () => {
    const renderer = await mount(<DevLeadSessionMark {...markProps({ rows: {} })} />)
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('DevLeadSessionHoverMark', () => {
  it('renders the explanation line while the row summary says mode is enabled', async () => {
    const rows: TestRows = {
      'session-1': { projectionValues: { [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: true } } },
    }
    const renderer = await mount(<DevLeadSessionHoverMark {...hoverMarkProps({ rows })} />)
    const line = renderer.root.findByProps({ 'data-devlead-row-hover': 'true' })
    expect(line.findAllByProps({ 'data-mock-icon': 'true' })).toHaveLength(0)
    expect(line.findAllByProps({ className: 'devlead-row-hover-active-dot' })).toHaveLength(1)
    expect(textOf(line)).toBe(zh['row.hover.enabled'])
  })

  it('renders the watched explanation line for a watched non-lead row', async () => {
    const rows: TestRows = {
      'lead-1': {
        projectionValues: {
          [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: true },
          [DEVLEAD_WATCH_PROJECTION_KEY]: { sessions: ['session-1'] },
        },
      },
    }
    const renderer = await mount(<DevLeadSessionHoverMark {...hoverMarkProps({ rows })} />)
    const line = renderer.root.findByProps({ 'data-devlead-row-hover': 'true' })
    expect(line.props['data-devlead-row-watched']).toBe('true')
    expect(line.findAllByProps({ 'data-mock-icon': 'true' })).toHaveLength(1)
    expect(textOf(line)).toBe(zh['row.hover.watched'])
  })

  it('renders nothing while the row summary says mode is disabled', async () => {
    const rows: TestRows = {
      'session-1': { projectionValues: { [DEVLEAD_MODE_PROJECTION_KEY]: { enabled: false } } },
    }
    const renderer = await mount(<DevLeadSessionHoverMark {...hoverMarkProps({ rows })} />)
    expect(renderer.toJSON()).toBeNull()
  })
})

/**
 * Minimal hook harness: renders the admission state and one trigger button.
 * @param props.executeCommand - injected command face to admit through.
 * @param props.resetKey - projection flag whose change retires stale feedback.
 * @returns the probe markup.
 */
function AdmissionProbe({ executeCommand, resetKey }: {
  readonly executeCommand: (line: string) => Promise<DevLeadCommandAdmission>
  readonly resetKey: unknown
}) {
  const { pending, failure, run } = useDevLeadAdmission(executeCommand, resetKey)
  return (
    <>
      <button
        data-admission-trigger="true"
        data-pending={pending ? 'true' : 'false'}
        data-failure={failure === null ? '' : failure.kind}
        onClick={() => {
          run('/devlead on')
        }}
      />
      <span data-admission-failure="true">{failure === null ? '' : failure.kind}</span>
    </>
  )
}

describe('useDevLeadAdmission', () => {
  it('submits one click once and settles out of pending', async () => {
    const executeCommand = vi.fn(async () => SUCCESS)
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    await settle(() => {
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('/devlead on')
    const trigger = renderer.root.findByProps({ 'data-admission-trigger': 'true' })
    expect(trigger.props['data-pending']).toBe('false')
    expect(trigger.props['data-failure']).toBe('')
  })

  it('admits only one command for two clicks in the same render cycle', async () => {
    const command = deferredAdmission()
    const executeCommand = vi.fn(() => command.promise)
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    const trigger = renderer.root.findByProps({ 'data-admission-trigger': 'true' })
    // React state has not re-rendered between these two calls: the gate must
    // close the same-render window before the control can re-render disabled.
    await act(async () => {
      trigger.props['onClick']()
      trigger.props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['data-pending'],
    ).toBe('true')

    command.resolve(SUCCESS)
    await settle(() => {})
    expect(
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['data-pending'],
    ).toBe('false')
  })

  it('stays pending until the command settles, then admits the next attempt', async () => {
    const command = deferredAdmission()
    const executeCommand = vi.fn()
      .mockImplementationOnce(() => command.promise)
      .mockResolvedValueOnce(SUCCESS)
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    const trigger = (): ReactTestInstance =>
      renderer.root.findByProps({ 'data-admission-trigger': 'true' })
    await act(async () => {
      trigger().props['onClick']()
    })
    // In flight: the surface stays pending and refuses further input.
    expect(trigger().props['data-pending']).toBe('true')
    expect(executeCommand).toHaveBeenCalledTimes(1)

    command.resolve(SUCCESS)
    await settle(() => {})
    expect(trigger().props['data-pending']).toBe('false')

    // The settle released the gate: a later attempt is admitted again.
    await settle(() => {
      trigger().props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
  })

  it('ignores a settle after unmount without warning or throwing', async () => {
    const command = deferredAdmission()
    const executeCommand = vi.fn(() => command.promise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    await act(async () => {
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['onClick']()
    })
    await unmount(renderer)

    command.resolve(SUCCESS)
    // The command settles after the surface collapsed; the hook must swallow
    // the dispatch instead of touching an unmounted component.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('keeps a settled failure and retires it when resetKey changes', async () => {
    const executeCommand = vi.fn(async (): Promise<DevLeadCommandAdmission> => {
      throw new Error('host down')
    })
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    await settle(() => {
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['onClick']()
    })
    expect(
      textOf(renderer.root.findByProps({ 'data-admission-failure': 'true' })),
    ).toBe('unexpected')

    // A projection change (the mode toggled from this or another surface)
    // retires feedback that belonged to the previous attempt.
    await act(async () => {
      renderer.update(<AdmissionProbe executeCommand={executeCommand} resetKey />)
    })
    expect(
      textOf(renderer.root.findByProps({ 'data-admission-failure': 'true' })),
    ).toBe('')
  })

  it('drops a failure that settles after the mode changed mid-flight', async () => {
    const command = deferredAdmission()
    const executeCommand = vi.fn(() => command.promise)
    const renderer = await mount(
      <AdmissionProbe executeCommand={executeCommand} resetKey={false} />,
    )
    await act(async () => {
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(1)

    // The mode flips from another source while the command is still in
    // flight: the pending attempt survives, but its feedback is now stale.
    await act(async () => {
      renderer.update(<AdmissionProbe executeCommand={executeCommand} resetKey />)
    })
    expect(
      renderer.root.findByProps({ 'data-admission-trigger': 'true' }).props['data-pending'],
    ).toBe('true')

    // The attempt settles with a failure that belonged to the old mode: it
    // must clear pending without resurrecting the stale failure on a surface
    // whose mode already moved on.
    command.resolve({ ok: false, error: { code: 'gateway/unavailable', message: 'offline' } })
    await settle(() => {})
    const trigger = renderer.root.findByProps({ 'data-admission-trigger': 'true' })
    expect(trigger.props['data-pending']).toBe('false')
    expect(trigger.props['data-failure']).toBe('')
    expect(textOf(renderer.root.findByProps({ 'data-admission-failure': 'true' }))).toBe('')

    // The gate released with the settle: a later attempt is admitted again.
    await settle(() => {
      trigger.props['onClick']()
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
  })
})
