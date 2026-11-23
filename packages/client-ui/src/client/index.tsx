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
 * The durable mode, watched-session set, and notification digest arrive through
 * `useProjection('devLead')` (the host pushes them from the Session log); mode
 * changes ride the Host `/devlead` command executor. This plugin therefore ships
 * no Remote API of its own — the injected face only binds command admission to
 * the surface's Session identity.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Client Remote merge (ctx.remote, including workspaceFiles) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
// Type-only: Host-authoritative Workspace catalog hooks for unlisted projects.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the Client Session Controller service (ctx.sessions) into this program.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
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
 * toggle in the composer toolbar, the enabled-only DevLeadBar status dock, and
 * the sidebar's per-Session DevLead marks.
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

  // No deployment-published board config means no tab, guide card, or header
  // button. Existing UI and Remote behavior stay exactly as before Step B.
  const board = currentDevLeadBoardConfig()
  if (board !== undefined) {
    const t = ctx.locale.bind(NS)
    ctx.effect(() => ctx.sidebarRightTabs.register({
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
    }), 'devlead: board tab')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: DEVLEAD_BOARD_TAB_ID,
      locale: NS,
      inject: () => ({ config: board, files: ctx.remote.workspaceFiles }),
    }, DevLeadBoardPanel))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: DEVLEAD_BOARD_TAB_ID,
      locale: NS,
    }, DevLeadBoardTitle))
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'devlead-board',
      // Next to the shipped Schedule entry (-5), left of the overflow menu.
      order: -4,
      locale: NS,
      inject: () => ({ onOpen: () => { ctx.sidebarRight.openTab(DEVLEAD_BOARD_TAB_KIND) } }),
    }, DevLeadBoardButton))
  }
}
