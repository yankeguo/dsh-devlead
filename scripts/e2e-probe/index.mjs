/**
 * Private end-to-end probe plugin for `scripts/e2e-smoke.mjs` (phase 2).
 *
 * The E2E harness needs one Host-side command that drives the DevLead
 * worktree-isolation happy path through the **real** 0.2.0 core API:
 *
 *   1. register the lead Session's own directory as a Workspace
 *      (`ctx.devLead.useWorkspace(agent, request, signal?)` — the 0.2.0
 *      live-lead signature);
 *   2. create a new Session requested with `isolation: 'worktree'` and no
 *      initial prompt (`ctx.devLead.createSession(agent, request, signal?)`);
 *   3. read the created Session back from the Host store and report what the
 *      Host actually did, as one JSON document.
 *
 * Everything the probe reports is read through services, never invented: the
 * E2E assertions compare `created.isolation` against Git facts and compare the
 * child Session's header/effective working directories against the checkout.
 *
 * The probe is a linked-root package of the throwaway profile (a symlink
 * under `<profile>/node_modules/@yankeguo/` pointing at this directory), so
 * its `@deepseek-ai/*` peer dependencies resolve to the installation's own
 * runtime copies instead of a second physical module graph.
 *
 * JSON contract the harness parses from the success text:
 *
 *   {
 *     created: DevLeadCreatedSession,        // session, workspace, prompted, isolation
 *     child: {
 *       sessionId: string,
 *       headerCwd: string | null,            // live child Session header cwd
 *       effectiveCwd: string | null           // ctx.workingDirectory.get(child Session)
 *     }
 *   }
 *
 * A missing service, a failed core call, or a malformed Host answer settles as
 * a command error result instead of throwing, so the E2E harness can print the
 * real failure instead of a generic command-execution error.
 *
 * Test-only package: private, never published, and not part of the workspace.
 * @module @yankeguo/dsh-devlead-e2e-probe
 */
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

/** Plugin name reported to the Cordis loader. */
export const name = 'devlead-e2e-probe'

/**
 * Services this plugin needs.
 *
 * `commands` provides the registry; `devLead` is the service under test.
 * `sessions` is injected because the probe reads the live child Session back
 * from the Host store — a Cordis service property, so it must be declared as a
 * dependency to be readable from this plugin context.
 */
export const inject = ['commands', 'devLead', 'sessions']

/** Stable, plugin-owned command-definition identity (mirrors the package name). */
const DEFINITION_ID = '@yankeguo/dsh-devlead-e2e-probe'
/** Command name; the harness dispatches `/${COMMAND_NAME}`. */
const COMMAND_NAME = 'devlead-e2e-worktree'

/** Render an unknown thrown value as one line. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Register the lead directory as a Workspace, create one worktree-isolated
 * Session, and report the created result plus the live child Session's
 * header/effective working directories.
 *
 * The lead Session's header cwd is the source checkout: the harness creates
 * that Session with `cwd = <scratch workspace>` and initializes the directory
 * as a real Git repository, which the experimental worktree service requires.
 * @param ctx - owning plugin context carrying `commands`, `devLead`, `sessions`.
 * @param invocation - the command invocation; its Agent is the calling lead.
 * @returns a success result whose text is the probe JSON, or an error result.
 */
async function executeProbe(ctx, invocation) {
  const path = invocation.agent.session.header.cwd
  if (typeof path !== 'string' || path.length === 0) {
    return {
      kind: 'error',
      text: 'devlead-e2e-probe: the lead Session records no header cwd, so no Workspace can be addressed',
    }
  }
  // No cancellation token: this is one deterministic test step (a Workspace
  // registration, one unprompted Session creation, one worktree checkout) and
  // the E2E RPC call bounds the overall wait.
  await ctx.devLead.useWorkspace(invocation.agent, { path }, undefined)
  const created = await ctx.devLead.createSession(invocation.agent, {
    isolation: 'worktree',
    watch: false,
  })
  const childSession = ctx.sessions.get(created.session.sessionId)
  const workingDirectory = ctx.get('workingDirectory')
  const child = {
    sessionId: String(created.session.sessionId),
    // The immutable header keeps the Workspace path; isolation only changes the
    // effective (durable working-directory projection) directory.
    headerCwd: childSession?.header?.cwd ?? null,
    effectiveCwd: childSession === undefined || workingDirectory === undefined
      ? null
      : workingDirectory.get(childSession),
  }
  return { kind: 'success', text: JSON.stringify({ created, child }) }
}

/** Register the probe command for every composed command adapter. */
export function apply(ctx) {
  ctx.commands.register({
    definitionId: CommandDefinitionId(DEFINITION_ID),
    name: COMMAND_NAME,
    description: 'E2E probe: create a worktree-isolated Session from this lead and report the isolation result.',
    // Text-only command: no `input.attachments` declaration, so the command
    // runtime rejects composer attachments before this handler runs.
    handler: async invocation => {
      try {
        return await executeProbe(ctx, invocation)
      } catch (error) {
        return { kind: 'error', text: `devlead-e2e-probe failed: ${messageOf(error)}` }
      }
    },
  })
}
