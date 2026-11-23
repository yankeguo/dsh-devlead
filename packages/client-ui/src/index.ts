/**
 * DevLead surface plugin, node half. The browser bundle keeps its existing UI;
 * this Host entry additionally publishes the configured board location for the
 * read-only board client introduced by Step B.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEVLEAD_BOARD_SCHEMA_VERSION } from '@yankeguo/dsh-devlead'

/** The Host core owns the one configured board path. */
export const inject = ['devLead']

/**
 * Inject the current board contract on every index/worker payload render.
 * Disabled boards deliberately publish no global.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => {
    const boardPath = ctx.devLead.board.path
    if (boardPath === undefined) return
    table.push({
      kind: 'global',
      name: '__DSH_DEVLEAD_BOARD__',
      value: {
        boardPath,
        schemaVersion: DEVLEAD_BOARD_SCHEMA_VERSION,
        // Browser schema validation must use the Host's node:path semantics,
        // not an operating-system guess from the path string or user agent.
        pathPlatform: process.platform === 'win32' ? 'win32' : 'posix',
      },
    })
  })
}
