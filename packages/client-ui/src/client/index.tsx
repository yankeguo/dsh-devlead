/**
 * DevLead surface plugin, browser half. Two kinds of registration share one
 * command face:
 *
 * - `conversation.input.left` carries the compact off-state switch in the
 *   composer toolbar. This is the human entry point, so an inactive Session
 *   keeps its composer clean and no DevLead bar appears in every conversation.
 * - `conversation.input.dock` carries the full DevLeadBar, rendered only while
 *   mode is enabled for that Session.
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
// Type-only: pulls the Client Remote merge (ctx.remote, ctx.remote.commands) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Client Session Controller service (ctx.sessions) into this program.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation service and the `conversation.input.dock` declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard kit (`useProjection` seat) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the ui-workspace SlotMap merge (the sidebar Session-row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { DevLeadBar, type DevLeadCommandInjected } from './DevLeadBar.tsx'
import { DevLeadIconToggle } from './DevLeadIconToggle.tsx'
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

/** Required services: slot registration, Session scope, Remote commands, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: dictionaries, the plugin stylesheet, the compact off-state
 * switch in the composer toolbar, the enabled-only DevLeadBar dock, and the
 * sidebar's per-Session DevLead marks.
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
    // contributions, so the compact switch stays ahead of any later entry.
    order: 12,
    locale: NS,
    inject: face,
  }, DevLeadIconToggle))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'devlead',
    // The shipped context stack orders Todo (0), Goal (10), and Queue (20):
    // the DevLead strip sits directly below the goal card.
    order: 12,
    locale: NS,
    inject: face,
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
}
