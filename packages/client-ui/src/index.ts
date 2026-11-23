/**
 * DevLead surface plugin, node half. The browser bundle keeps its own UI; this
 * Host entry publishes the current board location for the read-only board
 * client. The board follows one lead Session at a time, so the global also
 * carries that lead's identity and whether the deployment Config overrode the
 * default path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEVLEAD_BOARD_SCHEMA_VERSION } from '@yankeguo/dsh-devlead-protocol'

/** The Host core owns the one current board location. */
export const inject = ['devLead']

/**
 * Inject the current board contract on every index/worker payload render.
 * A board with no lead yet deliberately publishes no global: the browser also
 * derives the default path from a lead Session's workspace root, so a page
 * loaded before the lead existed still works without this global.
 * @param ctx - node plugin context carrying the Host DevLead service.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => {
    const boardPath = ctx.devLead.board.path
    const leadSessionId = ctx.devLead.boardLeadSessionId
    if (boardPath === undefined || leadSessionId === undefined) return
    table.push({
      kind: 'global',
      name: '__DSH_DEVLEAD_BOARD__',
      value: {
        boardPath,
        schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
        // Browser schema validation must use the Host's node:path semantics,
        // not an operating-system guess from the path string or user agent.
        pathPlatform: process.platform === 'win32' ? 'win32' : 'posix',
        leadSessionId,
        override: ctx.devLead.boardPathOverride === true,
      },
    })
  })
}
