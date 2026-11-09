/**
 * DevLead surface plugin, browser half: the `conversation.input.dock` entry
 * carrying the DevLeadBar strip.
 *
 * The durable mode, watched-session set, and notification digest arrive through
 * `useProjection('devLead')` (the host pushes them from the Session log); mode
 * changes ride the Host `/devlead` command executor. This plugin therefore ships
 * no Remote API of its own — the injected face only binds command admission to
 * the dock's Session identity.
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
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { DevLeadBar, type DevLeadDockInjected } from './DevLeadBar.tsx'
import { en, zh, type DevLeadKey } from './locales.ts'
import { ensureStyleTag } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The DevLead strip's copy. */
    devlead: DevLeadKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'devlead'

/** Required services: slot registration, Session scope, Remote commands, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: dictionaries, the plugin stylesheet, and the DevLeadBar
 * dock entry with its command-admission face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'devlead: dictionaries')
  ctx.effect(() => ensureStyleTag(), 'devlead: styles')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'devlead',
    order: 12,
    locale: NS,
    inject: (sessionId: SessionIdOf): DevLeadDockInjected => ({
      executeCommand: line => ctx.remote.commands.execute(sessionId, line, []),
    }),
  }, DevLeadBar))
}
