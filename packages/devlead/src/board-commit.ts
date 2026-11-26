/** Best-effort Git commit for the lead-owned `.dsh/devlead` directory. */

import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 10_000
const GIT_OUTPUT_MAX = 64 * 1024

/** One bounded Git process outcome. */
export interface DevLeadGitResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Narrow process seam used by tests; production never invokes a shell. */
export type DevLeadGitRunner = (
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<DevLeadGitResult>

/** Outcome of the optional post-board-write commit. */
export interface DevLeadBoardCommitResult {
  readonly commitHash?: string
  readonly warning?: string
}

function defaultRunner(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<DevLeadGitResult> {
  return new Promise(resolve => {
    execFile('git', [...args], {
      cwd,
      signal,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_MAX,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as unknown as { code: number }).code
        : error === null ? 0 : null
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function detail(result: DevLeadGitResult): string {
  const text = `${result.stderr.trim()} ${result.stdout.trim()}`.trim()
  return text.length === 0 ? `exit ${String(result.code)}` : text.slice(0, 500)
}

/**
 * Stage and commit only `.dsh/devlead` beneath the original lead workspace.
 * The board write is already durable when this runs, so every Git failure is a
 * warning rather than an exception or a misleading rollback.
 */
export async function commitDevLeadBoard(
  workspaceRoot: string,
  signal?: AbortSignal,
  run: DevLeadGitRunner = defaultRunner,
): Promise<DevLeadBoardCommitResult> {
  const repository = await run(workspaceRoot, ['rev-parse', '--show-toplevel'], signal)
  if (repository.code !== 0) {
    return { warning: `board was written but not committed: not a usable Git repository (${detail(repository)})` }
  }
  const path = '.dsh/devlead'
  const added = await run(workspaceRoot, ['add', '--', path], signal)
  if (added.code !== 0) {
    return { warning: `board was written but git add failed (${detail(added)})` }
  }
  const committed = await run(workspaceRoot, [
    'commit', '--only', '-m', 'chore(devlead): update project board', '--', path,
  ], signal)
  if (committed.code !== 0) {
    return { warning: `board was written but git commit failed (${detail(committed)})` }
  }
  const head = await run(workspaceRoot, ['rev-parse', 'HEAD'], signal)
  const commitHash = head.stdout.trim()
  if (head.code !== 0 || !/^[0-9a-f]{40}$/u.test(commitHash)) {
    return { warning: `board was committed but its commit hash could not be read (${detail(head)})` }
  }
  return { commitHash }
}
