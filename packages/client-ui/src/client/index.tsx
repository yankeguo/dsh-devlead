/**
 * DevLead surface plugin, browser half. Two kinds of registration share one
 * command face:
 *
 * - `conversation.input.left` carries the compact DevLead toggle in the
 *   composer toolbar. It is mounted in both mode states and is the single
 *   on/off switch, so an inactive Session keeps its composer clean and the
 *   control stays in place while the enabled-only strip appears and disappears.
 * - `conversation.input.dock` carries the status-only DevLeadBar, rendered
 *   only while mode is enabled for that Session.
 * - `sidebar.session.row.trailing` carries the Session-list mark, and
 *   `sidebar.session.row.hover` restates it in the row's hover card. Both read
 *   the summary-sized `devLeadMode` projection, because the digest-bearing
 *   `devLead` projection is excluded from Session summaries by design.
 *
 * The read-only project board is a lead-only surface, so it is *dynamic* on top
 * of that static face: its right-Sidebar tab type, guide card, keyed body, and
 * live chip title are registered exactly while the on-screen Session is an
 * eligible lead (top-level, mode on, and a board path resolvable from the Host
 * global or the Session's own workspace root). The header action stays
 * registered statically and gates itself on the same summary facts.
 *
 * The durable mode, watched-session set, and notification digest arrive through
 * `useProjection('devLead')` (the host pushes them from the Session log); mode
 * changes ride the Host `/devlead` command executor. This plugin therefore ships
 * no Remote API of its own — the injected face only binds command admission and
 * the read-only Workspace Files seat to the surface's Session identity.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Client Remote merge (ctx.remote, including workspaceFiles) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
// Type-only: Host-authoritative Workspace catalog hooks for unlisted projects.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the Client Session Controller service (ctx.sessions) in.
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation service and the `conversation.input.dock` declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: right-Sidebar tab registry/controller and keyed body slot.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the Session standard kit (`useProjection` seat) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFlatListOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DevLeadBar } from './DevLeadBar.tsx'
import { DevLeadBoardButton, DevLeadBoardTitle } from './DevLeadBoardButton.tsx'
import { DevLeadBoardPanel } from './DevLeadBoardPanel.tsx'
import {
  currentDevLeadBoardConfig,
  DEVLEAD_BOARD_TAB_ID,
  DEVLEAD_BOARD_TAB_KIND,
  resolveDevLeadBoardSessionConfig,
} from './board.ts'
import { DevLeadIconToggle, type DevLeadCommandInjected } from './DevLeadIconToggle.tsx'
import { DevLeadSessionHoverMark } from './DevLeadSessionHoverMark.tsx'
import { DevLeadSessionMark } from './DevLeadSessionMark.tsx'
import { en, zh, type DevLeadKey } from './locales.ts'
import { ensureStyleTag } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The DevLead surfaces' copy. */
    devlead: DevLeadKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'devlead'

/** Required services: slots, Session scope, read-only files, right Sidebar, commands, and copy. */
export const inject = [
  'slots',
  'sessions',
  'remote',
  'remote.commands',
  'remote.workspaceFiles',
  'locale',
  'sidebarRight',
  'sidebarRightTabs',
  'workspaces',
]

/**
 * Client plugin body: dictionaries, the plugin stylesheet, the both-state
 * toggle in the composer toolbar, the enabled-only DevLeadBar status dock, the
 * sidebar's per-Session DevLead marks, and the lead-only board surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'devlead: dictionaries')
  ctx.effect(() => ensureStyleTag(), 'devlead: styles')

  /** One command-admission face bound to the surface's Session identity. */
  const face = (sessionId: SessionIdOf): DevLeadCommandInjected => ({
    executeCommand: line => ctx.remote.commands.execute(sessionId, line, []),
  })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'devlead',
    // No shipped entry occupies this list; the order only sequences additive
    // contributions, so the compact toggle stays ahead of any later entry.
    order: 12,
    locale: NS,
    inject: face,
  }, DevLeadIconToggle))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'devlead',
    // The shipped context stack orders Todo (0), Goal (10), and Queue (20):
    // the status strip sits directly below the goal card. It has no injected
    // command face: only the composer-toolbar toggle submits commands.
    order: 12,
    locale: NS,
  }, DevLeadBar))

  // The sidebar Session row renders trailing mark seats for every Session; the
  // component itself returns nothing unless the row's summary says DevLead mode
  // is on. The mark is non-interactive, so it needs no injected business face:
  // the standard `useSessions` hook reads the row's own summary.
  ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing',
    id: 'devlead',
    // After the shipped/experimental trailing marks; no shipped entry occupies
    // this id, so the order only sequences additive contributions.
    order: 20,
    locale: NS,
  }, DevLeadSessionMark))

  // The row's trailing seat is hidden while the row is hovered, so the hover
  // card carries the same fact as an explicit explanation line.
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover',
    id: 'devlead',
    order: 20,
    locale: NS,
  }, DevLeadSessionHoverMark))

  // The repo-wide typecheck also sees the Host `ctx.sessions` store merged
  // under the same Context name; this browser plugin always receives the Client
  // Session Controller, whose `list` observable is the catalog to follow.
  const sessions = ctx.sessions as unknown as ISessions

  // The board is a lead-only surface: it follows the Session on screen and
  // exists exactly while that Session is an eligible lead. The manager below
  // keeps the tab type, its guide card, keyed body, and live chip title in sync
  // with the Session list and the right Sidebar's on-screen Session; disposing
  // them also closes the on-screen Session's lingering board tabs, because a
  // kind with no registered type would only draw the shell's fallback notice.
  let boardSurfaceDisposers: readonly (() => void)[] = []

  /** Whether this listed Session may show any board surface. */
  const boardEligible = (sessionId: SessionIdOf): boolean =>
    resolveDevLeadBoardSessionConfig(
      sessionId,
      sessions.list.getSnapshot().byId[sessionId],
      currentDevLeadBoardConfig(),
    ) !== undefined

  /** Close the board tabs the on-screen Session still holds open. */
  const closeBoardTabs = (): void => {
    const onScreen = ctx.sidebarRight.mounted.getSnapshot()
    if (onScreen === undefined) return
    for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
      if (tab.sessionId !== onScreen || tab.kind !== DEVLEAD_BOARD_TAB_KIND) continue
      try {
        ctx.sidebarRight.close(tab.tabId)
      } catch {
        // An unadopted Session or an already-closed tab has nothing to tear down.
      }
    }
  }

  /** Drop the dynamic board surfaces and the tabs that outlived their type. */
  const disposeBoardSurfaces = (): void => {
    const disposers = boardSurfaceDisposers
    if (disposers.length === 0) return
    boardSurfaceDisposers = []
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // Teardown is best effort: a partially torn-down slot must not leak a
        // registration into the next eligible Session.
      }
    }
    closeBoardTabs()
  }

  /**
   * Register the board surfaces for one eligible lead, exactly once.
   *
   * Registrations are collected incrementally: if a later one throws (a wiring
   * error, or a slot that is being torn down concurrently), everything already
   * registered is disposed before the failure is reported, so a retry can never
   * double-register a type id or a keyed body.
   * @param sessionId - the Session whose eligibility was just established.
   * @returns whether the surfaces are in place for that Session.
   */
  const ensureBoardSurfaces = (sessionId: SessionIdOf | undefined): boolean => {
    if (sessionId === undefined) return false
    if (boardSurfaceDisposers.length > 0) return true
    if (!boardEligible(sessionId)) return false
    const t = ctx.locale.bind(NS)
    const disposers: (() => void)[] = []
    try {
      disposers.push(ctx.sidebarRightTabs.register({
        id: DEVLEAD_BOARD_TAB_ID,
        kind: DEVLEAD_BOARD_TAB_KIND,
        title: () => t('board.title'),
        guide: [{
          id: 'open',
          order: 30,
          title: () => t('board.title'),
          description: () => t('board.guide'),
          icon: IconFlatListOutlineRegular,
        }],
      }))
      disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: DEVLEAD_BOARD_TAB_ID,
        locale: NS,
        // The body resolves its own path from the tab Session's summary plus
        // the Host global, so the injected face keeps only the shared Remote.
        inject: () => ({ files: ctx.remote.workspaceFiles }),
      }, DevLeadBoardPanel)))
      disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: DEVLEAD_BOARD_TAB_ID,
        locale: NS,
      }, DevLeadBoardTitle)))
    } catch {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Cleaning up a half-registered group is best effort; the next
          // notification retries from a clean slate.
        }
      }
      return false
    }
    boardSurfaceDisposers = disposers
    return true
  }

  // The header action stays registered for every Session; the component gates
  // itself on the same summary facts. Its open synchronously repairs the
  // registration first, so a click that lands between two list notifications
  // still opens a real tab instead of throwing on an unknown kind.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'devlead-board',
    // Next to the shipped Schedule entry (-5), left of the overflow menu.
    order: -4,
    locale: NS,
    inject: (sessionId: SessionIdOf) => ({
      onOpen: () => {
        if (!ensureBoardSurfaces(sessionId)) return
        ctx.sidebarRight.openTab(DEVLEAD_BOARD_TAB_KIND)
      },
    }),
  }, DevLeadBoardButton))

  ctx.effect(() => {
    const sync = (): void => {
      const onScreen = ctx.sidebarRight.mounted.getSnapshot()
      if (onScreen !== undefined && boardEligible(onScreen)) {
        ensureBoardSurfaces(onScreen)
      } else {
        disposeBoardSurfaces()
        // A restored right-Sidebar tab can predate this page's registration:
        // the tab was persisted for the on-screen Session while that Session is
        // not (or is no longer) an eligible lead and the surfaces were never
        // registered here. Leaving it open would only show the shell's fallback
        // notice, so close the on-screen Session's board tabs even when
        // `disposeBoardSurfaces` had nothing to dispose.
        closeBoardTabs()
      }
    }
    const offMounted = ctx.sidebarRight.mounted.subscribe(sync)
    const offSessions = sessions.list.subscribe(sync)
    sync()
    return () => {
      offMounted()
      offSessions()
      disposeBoardSurfaces()
      // Also sweep a restored tab that no surface group owned in this page life.
      closeBoardTabs()
    }
  }, 'devlead: board surfaces')
}
