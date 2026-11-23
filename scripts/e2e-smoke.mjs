#!/usr/bin/env node
/**
 * Isolated end-to-end smoke test of the built DevLead plugin suite against the
 * installed DeepSeek Harness Web runtime.
 *
 * It boots a throwaway DSH_HOME under the OS temp directory (never `~/.dsh`),
 * loads the suite through one of the two documented local flows, logs in with
 * the launch token over the same HTTP API the browser uses, and asserts the
 * product behaviors that only appear in a real Host.
 *
 * Every flow runs five phases against the same scratch root and the same
 * throwaway profile (phase 1 and phase 1b also share the same durable DSH_HOME
 * state):
 *
 *   phase 1 — default composition. The shipped default Web profile (base +
 *             web-app) carries no experimental worktree bundle, so DevLead must
 *             report the optional capability as unavailable and keep working
 *             normally:
 *               - the browser half is discovered (boot graph client entry +
 *                 declared injects);
 *               - `/devlead` is a registered human command and the `devLead`
 *                 projection is served with its default wire value;
 *               - the summary-sized `devLeadMode` projection is registered,
 *                 follows the mode, and rides the `session/list` summary rows
 *                 the sidebar renders, while the digest-bearing `devLead` value
 *                 stays out of those summaries;
 *               - `/devlead on` flips the durable mode and both projections
 *                 follow it;
 *               - `watch` addresses a real child Session and self-watch is
 *                 rejected;
 *               - a watched child `turn/end` writes a durable notification into
 *                 the lead Session and the projection exposes it;
 *               - `/devlead status` reports `Worktree isolation: unavailable`;
 *               - the default composition configures no board path: before any
 *                 lead the client plugin still statically declares its board
 *                 services but no `__DSH_DEVLEAD_BOARD__` global is injected;
 *                 after `/devlead on` the Host derives
 *                 `<scratch workspace>/.dsh/devlead/board.json`, publishes it
 *                 (lead id + override:false) and precreates the parent.
 *             30 checks. The final `/devlead status` + `/devlead off` checks
 *             move to phase 1b, so this instance is stopped with the enabled
 *             mode, watch set, and notification digest still durable for the
 *             restart assertions.
 *
 *   phase 1b — cold lead rehydration. The SAME loading flow restarts against
 *             the SAME scratch home; the restarted Host must rebuild the state
 *             the stopped process left in the Session logs:
 *               - the cold lead's projection still folds as enabled and still
 *                 carries the watched child and the first-turn notification
 *                 (read from the durable log without activating the Session);
 *               - a second prompt resumes the cold child Session;
 *               - its turn-2 `turn/end` produces a NEW notification in the cold
 *                 lead's projection, which only happens when the hub rebuilt
 *                 its watch index from persisted records (D2 rehydrate) and
 *                 resumed the cold lead to persist and deliver the wake
 *                 (`wakeColdSession` defaults to `true`);
 *               - the cold lead's derived board global is published before any
 *                 resume (its persisted header cwd is enough);
 *               - the resumed, now-live lead answers `/devlead status` (watched
 *                 child + recent notification) and the final `/devlead off`,
 *                 which removes the derived board global;
 *               - a lead enabled in a second scratch workspace switches the
 *                 derived board path immediately (no configuration/restart).
 *             18 checks.
 *
 *   phase 2 — experimental worktree composition. The same profile's
 *             `dsh.profile.bundles` gains the official
 *             `@deepseek-ai/dsh-experimental-forge-bundle` (the installed app's
 *             bundle inventory resolves it at boot, so no `pnpm install` runs),
 *             the private `scripts/e2e-probe` package is linked as a profile
 *             package under `node_modules/@yankeguo/`, and the SAME loading flow
 *             restarts with one extra `--patch` overlay inserting the probe row
 *             (the patch flow keeps its devlead overlay as the first
 *             `--patch`). The probe registers the lead directory as a
 *             Workspace, creates an unprompted Session with
 *             `isolation: 'worktree'`, and returns the created result as JSON.
 *             Phase 2 asserts `/devlead status` reports `Worktree isolation:
 *             available` and verifies the real facts: the checkout lives under
 *             `<workspace>/.agents/worktrees/`, Git lists the worktree, the
 *             branch ref exists, `baseCommit` equals the workspace `HEAD`, the
 *             child Session's effective working directory is the checkout, its
 *             header cwd stays the Workspace path, and the Session belongs to
 *             the registered Workspace; the phase then releases its DevLead
 *             slot so the single-active phase 3 can enable its own lead. The
 *             configured boardPath override is active here, so this phase also
 *             proves the override wins over the workspace derivation and is
 *             published as `override:true`. The scratch workspace is a real Git
 *             repository (one seed commit) because the worktree service
 *             branches from its `HEAD`.
 *             24 checks.
 *
 *   phase 3 — close tools, dispatch routing, and triage policy. The same profile restarts (the
 *             probe package is linked and its overlay applied; the worktree
 *             bundle is not required) and drives the close lifecycle through
 *             `ctx.devLead`:
 *               - a real step-time tool activation (`ctx.tools.resolve`) admits
 *                 exactly the eighteen lead `devlead_*` tools while the mode is on
 *                 and none while it is off, both before and after a toggle;
 *               - a real watched non-lead child step admits exactly
 *                 `devlead_report`, receives the one-way report policy, and a
 *                 real `reportProgress` call is durably outboxed (`durable:true`,
 *                 `queued:false` on the default storage composition) and lands
 *                 in the lead's durable digest;
 *               - a real structured multi-question `ask_user_question` call
 *                 executed through the Host tools pipeline as a watched child
 *                 is denied before the child's own question UI runs, the
 *                 complete structured payload lands in the lead's durable
 *                 report digest, and the lead log records the
 *                 `lane:'action-required'` next-step wake admission (the
 *                 question gate); the deny stays soft: a sibling read-only
 *                 call still completes and no child turn is forced to end
 *                 (case 33);
 *               - a real `devlead_report({kind:'question'})` batch from inside
 *                 the watched child: the durable receipt sets
 *                 `turnEndRequested:true` with the executor `concludesTurn`
 *                 marker, the batch completes, a committed next-step input
 *                 survives, and the lead digest/wake carry the text question
 *                 (full wake payload deep-compare); a write-protected outbox
 *                 window produces the memory-only receipt (`durable:false`,
 *                 no turn end, restatement warning), and a fresh recovery
 *                 report proves writability/durable delivery returned (no
 *                 automatic-replay claim);
 *               - two REAL prompted child turns against a scripted
 *                 `llm/stream` script (real agent-loop events, no provider
 *                 credential): a concluding question batch still runs a
 *                 committed next-step marker in a later real step before the
 *                 single completed turn/end, and a gate-denied
 *                 `ask_user_question` does not stop the scripted model from
 *                 continuing with later steps (case 33);
 *               - Phase 1d answer routing: a REAL scripted child turn where the
 *                 lead answers the running child's forwarded question via
 *                 `promptSession(intent:'answer')` during the glob dispatch — the
 *                 answer steers next-step and is presented in a later real step
 *                 before the single completed turn/end, the same-key/same-text
 *                 retry returns the original receipt, a different answer conflicts
 *                 (DEVLEAD_QUESTION_ALREADY_ANSWERED), and the lead's durable
 *                 answer record + derived view report answered/presented;
 *               - Phase 1d answer inbox lifecycle: running-child answer delivery
 *                 metadata (queuedInputs intent/questionId/wakeRequested/
 *                 deliveryState), retraction refusing the answer but accepting
 *                 background/instruction, background injecting without a wake,
 *                 and running-child interrupt `clear-own` keeping the pending
 *                 answer (dropping the own instruction, keeping human input)
 *                 while `clear-all` discards it and reopens the question through
 *                 the real workspace/session-stop fan-out;
 *               - the assembled `devlead:policy` section carries judgment-based
 *                 closing, its safety boundaries, and the feasibility-triage /
 *                 open-question handoff to the dispatched Session;
 *               - archiving a prompted child updates the durable registry
 *                 archive set and the archived view/listing row, a repeated
 *                 archive is an idempotent `stopped:false` no-op, and
 *                 unarchiving restores the Session with its log intact;
 *               - a temporary `workspace/session-activity` provider makes an
 *                 active Session refuse with `DEVLEAD_SESSION_ACTIVE`; the
 *                 `stopRunning` retry archives it, reports `stopped:true`, and
 *                 observes the Host `workspace/session-stop` dispatch;
 *               - the lead Session cannot archive itself (`DEVLEAD_INVALID_INPUT`);
 *               - removing the scratch Workspace drops the registry entry while
 *                 the directory, a marker file, and the Session log survive; the
 *                 Session becomes ungrouped, and re-registering the directory
 *                 yields a new Workspace id that does not adopt it;
 *               - `devlead_list_models` returns the Host catalog view (default
 *                 selection, providers, failures); a credential-less Host has
 *                 empty provider/failure arrays with a real default, reported
 *                 as-is;
 *               - creation-time dispatch settings: a model selected from the
 *                 Host catalog (or the deployment default when the catalog is
 *                 unavailable) is recorded on the child Session and in its
 *                 durable log, Agent Teams `true`/`false` is applied and its
 *                 `team/mode` event is durable, an omitted setting leaves the
 *                 result fields absent, an unavailable model fails before any
 *                 Session is created, and the profile default model is read
 *                 before/after to prove it was never rewritten. When the Host
 *                 cannot expose a model catalog (no provider credentials), the
 *                 positive model checks are reported as SKIP, not faked.
 *                 Agent Teams is version-adaptive: rc.2+ (default composition)
 *                 must apply it, while an rc.1 Host must reject the explicit
 *                 request with DEVLEAD_TEAM_UNAVAILABLE and create nothing.
 *             140 checks (including the derived board path, four real Host
 *             board writes — CAS plus workspace-path/title references — real
  *             markdown-note create/append, the injected
 *             browser global, independent index/markdown disk read-back,
  *             browser-facing workspaceFiles stat/readBytes, lead-off store
 *             release and the mode-off board state; the pre-board
 *             total was 128).
 *
 *   phase 1e — message-lane delivery (DESIGN §4.4.4/§4.4.7/§4.4.11/§4.4.12).
 *             The same profile restarts with the probe overlay and a fresh
 *             lead; each lane probe drains the lead first so it starts quiet:
 *               - P1/P2 progress/fyi reports inject at next-step on the
 *                 background lane (wakeRequested:false) and start NO new lead
 *                 turn; devlead_notifications and devlead_get_session self-read
 *                 carry lane 'background' + deliveryState 'delivered';
 *               - P3/P4 blocked/decision reports steer [DEV LEAD ACTION
 *                 REQUIRED] wakes carrying the full message, report id, and
 *                 observed child state; digest rows carry lane 'action-required';
 *               - a REAL scripted completed child turn rides the turn-notice
 *                 [DEV LEAD NOTIFICATION] followup, while a REAL scripted turn
 *                 whose adapter throws settles turn/end error and rides the
 *                 [DEV LEAD REVIEW REQUIRED] action-required steer;
 *               - the question + turn-end double-wake merge writes
 *                 wakeSuppressedByReportId/wakeSuppressionReason onto the
 *                 notification row and includes the turn-end in the question wake;
 *               - filling the shared 16-pending-per-pair action cap accepts 17
 *                 distinct reports (1 parked + 16 pending) and refuses the 18th
 *                 with DEVLEAD_DELIVERY_RATE_LIMITED (no silent drop);
 *               - metricsSnapshot exposes delivery totals per lane/outcome plus
 *                 suppression/guard counters with low-cardinality enum labels only.
 *             31 checks.
 *
 * `--no-worktree` skips phase 2 only (debugging escape hatch when the
 * experimental composition cannot boot on this machine); phases 1, 1b, 3, and 1e
 * still run.
 *
 * Check counts are PINNED per phase (EXPECTED_CHECKS, baseline DSH
 * 0.2.2-rc.5): phase 1 = 30, phase 1b = 18, phase 2 = 24, phase 3 = 140,
 * phase 1e = 31, so every flow reports 243/243 checks (240 PASS + 3
 * credential-less SKIP) when all five phases pass (`--no-worktree` skips
 * phase 2: 219/219). A deleted or added check fails the phase through the count
 * pin. Run both flows before a release:
 *
 *   node scripts/e2e-smoke.mjs --flow patch
 *   node scripts/e2e-smoke.mjs --flow installed
 *
 * Two loading flows are exercised because they resolve the DSH runtime
 * differently:
 *
 *   patch      `pnpm dev:patch` overlay: the script also registers the checkout
 *              as a linked root of the throwaway profile, so the absolute-path
 *              plugin rows share the installation's `@deepseek-ai/*` module
 *              instances (DeepSeek Harness app-boot profile resolution routes
 *              each `peerDependencies` name of an importer under a linked root
 *              to the installation package). Without that link the process
 *              holds two copies of the session runtime and private class brand
 *              checks fail at the first `appendPluginRecord`.
 *   installed  `scripts/install-profile.mjs` package symlinks under the profile
 *              `node_modules`, the same shape an npm install produces.
 *
 * The child Session is prompted with provider/infrastructure credentials
 * removed from the child environment (explicit names plus common API-key /
 * token / secret patterns), so its turn settles deterministically as a provider
 * error: a real `turn/end` event that produces a real notification without
 * spending tokens.
 *
 * This is a LOCAL acceptance harness: it requires the installed DSH desktop
 * runtime (or `DSH_BIN`) and never runs in CI.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs [--flow patch|installed] [--no-build]
 *                              [--no-worktree] [--root <dir>] [--port <n>]
 *                              [--verbose]
 *
 * Environment:
 *   DSH_BIN   CLI to boot (default: `dsh` on PATH, for example the packaged
 *             `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`)
 *
 * Exit code 0 when every check passes and the spawned instance is torn down.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Scratch directory and throwaway profile name. */
const SCRATCH_NAME = 'devlead-e2e'
/** Marker file a reusable `--root` must carry before the script may delete it. */
const SCRATCH_MARKER = '.devlead-e2e-scratch'
/** Name of the profile `node_modules` link that registers the checkout as a linked root. */
const REPO_LINK_NAME = 'devlead-repo'
/** Official optional bundle whose layer composes the experimental Git worktree capability. */
const WORKTREE_BUNDLE = '@deepseek-ai/dsh-experimental-forge-bundle'
/** Private E2E probe package in `scripts/e2e-probe`, linked as a profile package in phases 2 and 3. */
const PROBE_PACKAGE = '@yankeguo/dsh-devlead-e2e-probe'
/** Worktree command the probe registers; phase 2 dispatches `/${PROBE_COMMAND}`. */
const PROBE_COMMAND = 'devlead-e2e-worktree'
/** Inspection command: step-visible DevLead tools + resident policy text. */
const PROBE_INSPECT_COMMAND = 'devlead-e2e-inspect'
/** Close command: archive/unarchive/remove through the real Host. */
const PROBE_CLOSE_COMMAND = 'devlead-e2e-close'
/** Board command: real writes (CAS + path/title refs) plus a Host read-back. */
const PROBE_BOARD_COMMAND = 'devlead-e2e-board'
/** Board activation facts plus one real read, including the disabled failure. */
const PROBE_BOARD_STATE_COMMAND = 'devlead-e2e-board-state'
/** Dispatch-settings command: creation-time model selection + Agent Teams. */
const PROBE_DISPATCH_COMMAND = 'devlead-e2e-dispatch'
/** Create one idle watched child for report-surface checks. */
const PROBE_WATCH_CHILD_COMMAND = 'devlead-e2e-watch-child'
/** Send one real report from inside the watched child. */
const PROBE_REPORT_COMMAND = 'devlead-e2e-report'
/** Drive the watched-Session question gate through a real ask_user_question call. */
const PROBE_QUESTION_COMMAND = 'devlead-e2e-question'
/** Drive the devlead_report question conclude/durable paths from inside the watched child. */
const PROBE_QUESTION_REPORT_COMMAND = 'devlead-e2e-question-report'
/** Real scripted child turn: a concluding question batch still runs committed next-step work. */
const PROBE_QUESTION_TURN_COMMAND = 'devlead-e2e-question-turn'
/** Real scripted child turn: a native-gate deny does not stop the model continuing (case 33). */
const PROBE_QUESTION_CONTINUE_COMMAND = 'devlead-e2e-question-continue'
/** Real scripted child turn: the lead answers a running child via steer (Phase 1d). */
const PROBE_ANSWER_TURN_COMMAND = 'devlead-e2e-answer-turn'
/** Answer inbox lifecycle: delivery metadata, retract refusal, clear-own/clear-all (Phase 1d). */
const PROBE_ANSWER_INBOX_COMMAND = 'devlead-e2e-answer-inbox'
/** Phase 1e: P1/P2 background inject (no wake) + read-tool lane/deliveryState output. */
const PROBE_LANES_BACKGROUND_COMMAND = 'devlead-e2e-lanes-background'
/** Phase 1e: P3/P4 blocked/decision action-required steer wakes with the full message. */
const PROBE_LANES_ACTION_COMMAND = 'devlead-e2e-lanes-action'
/** Phase 1e: T1 completed followup vs T2 failed/interrupted review steer wakes. */
const PROBE_LANES_TURN_COMMAND = 'devlead-e2e-lanes-turn'
/** Phase 1e: question + turn-end double-wake merge suppression fields. */
const PROBE_LANES_MERGE_COMMAND = 'devlead-e2e-lanes-merge'
/** Phase 1e: 16-pair action cap overflow returns DEVLEAD_DELIVERY_RATE_LIMITED. */
const PROBE_LANES_RATE_COMMAND = 'devlead-e2e-lanes-rate'
/** Phase 1e: low-cardinality delivery/suppression/guard metrics snapshot. */
const PROBE_LANES_METRICS_COMMAND = 'devlead-e2e-lanes-metrics'
/** Default board file path the Host derives from one Session workspace root. */
function derivedBoardPath(workspaceRoot) {
  return join(workspaceRoot, '.dsh', 'devlead', 'board.json')
}

/** Notes are siblings of board.json, never fields inside its 256 KiB budget. */
function derivedNotesIndexPath(workspaceRoot) {
  return join(dirname(derivedBoardPath(workspaceRoot)), 'notes', 'index.json')
}

/** Decode the HTTP bridge's Uint8Array JSON representation without assuming one envelope spelling. */
function decodeRemoteBytes(value) {
  const data = value?.data
  if (typeof data === 'string') return Buffer.from(data, 'base64').toString('utf8')
  if (Array.isArray(data)) return Buffer.from(data).toString('utf8')
  if (data?.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data).toString('utf8')
  if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data).filter(key => /^\d+$/u.test(key)).sort((a, b) => Number(a) - Number(b))
    return Buffer.from(keys.map(key => data[key])).toString('utf8')
  }
  throw new Error(`workspaceFiles/readBytes returned an unknown binary shape: ${JSON.stringify(data)?.slice(0, 120)}`)
}

/**
 * Pinned per-phase check totals of the current harness (baseline: DSH
 * 0.2.2-rc.5). `Checks.summarize` fails when a phase reports a different
 * count, so deleting or silently skipping a check cannot pass unnoticed.
 */
const EXPECTED_CHECKS = { phase1: 30, phase1b: 18, phase2: 24, phase3: 140, phase1e: 31 }
/** DSH version the pinned totals and scripted-turn contracts are verified against. */
const BASELINE_DSH_VERSION = '0.2.2-rc.5'
/** Probe command: queued-inbox visibility / ownership / idempotent retraction. */
const PROBE_INBOX_COMMAND = 'devlead-e2e-inbox'
/** Exact DevLead tool surface an enabled lead step admits. */
const DEVLEAD_TOOL_NAMES = [
  'devlead_archive_session',
  'devlead_board_note_read',
  'devlead_board_note_write',
  'devlead_board_read',
  'devlead_board_update',
  'devlead_create_session',
  'devlead_get_session',
  'devlead_list_agent_presets',
  'devlead_list_models',
  'devlead_list_sessions',
  'devlead_list_workspaces',
  'devlead_notifications',
  'devlead_prompt_session',
  'devlead_remove_workspace',
  'devlead_retract_input',
  'devlead_unarchive_session',
  'devlead_use_workspace',
  'devlead_watch_session',
]
/** Default checkout pool of the experimental worktree service, relative to the repository root. */
const WORKTREE_DIRECTORY = '.agents/worktrees'
/**
 * Environment names that carry a model-provider or infrastructure credential.
 * The child runtime is supposed to fail deterministically without provider
 * access; scrub by pattern instead of maintaining a provider-name allowlist.
 */
const SECRET_ENV_PATTERN = /(?:^|_)(?:API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PRIVATE[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|TOKEN)(?:_|$)/iu
/** Readiness line printed by the Web app once the server listens. */
const READY_PATTERN = /dsh web: (http:\/\/\S+)/
/** A durable notification identity: session id, turn, transition. */
const NOTIFICATION_ID_PATTERN = /^.+:\d+:(?:completed|aborted|blocked|error|max-tokens|interrupted|forked)$/u
/** Upper bound for one unary RPC call that is not a long poll. */
const RPC_TIMEOUT_MS = 30_000
/** Upper bound for the boot readiness line. */
const READY_TIMEOUT_MS = 120_000
/** Upper bound for a child turn to settle. */
const TURN_TIMEOUT_MS = 60_000
/** Upper bound for the projection to expose the notification. */
const NOTIFICATION_TIMEOUT_MS = 20_000
/** Upper bound for a restarted Host to rehydrate, resume a cold lead, and expose its new notification. */
const COLD_NOTIFICATION_TIMEOUT_MS = 45_000
/** Upper bound for the phase-3 close command (it waits for one prompted child turn). */
const CLOSE_PROBE_TIMEOUT_MS = 120_000
/** Upper bound for the phase-3 dispatch command (model validation + several creates). */
const DISPATCH_PROBE_TIMEOUT_MS = 120_000

const USAGE = `Usage: node scripts/e2e-smoke.mjs [options]

Options:
  --flow <patch|installed>  loading flow to exercise (default: patch)
  --no-build                reuse the current packages/*/lib artifacts
  --no-worktree             skip phase 2 (the experimental worktree composition);
                            phases 1, 1b, 3, and 1e still run (debugging escape hatch,
                            the default runs all four phases)
  --root <dir>              scratch directory under ${tmpdir()} (default: a unique one);
                            an existing root is reused only when it carries ${SCRATCH_MARKER}
  --port <n>                Web port; 0 lets the OS pick one (default: 0)
  --verbose                 stream the Web runtime output
  -h, --help                show this help

Environment:
  DSH_BIN  DeepSeek Harness CLI to boot (default: dsh on PATH)`

/** Render an unknown thrown value as one line. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Key-order-insensitive JSON serialization for deep payload comparisons. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Hide the launch token in a runtime URL before printing or logging it. */
function redactUrl(url) {
  return url.replace(/\?token=.*$/u, '?token=…')
}

/** Parse the command line, exiting on invalid input or an explicit help request. */
function parseArgs(argv) {
  const options = {
    flow: 'patch',
    build: true,
    worktree: true,
    root: undefined,
    port: 0,
    verbose: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    /** Read the value of a `--flag value` pair. */
    const valueOf = (flag) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--flow': {
        const flow = valueOf('--flow')
        if (flow !== 'patch' && flow !== 'installed') throw new Error(`--flow must be "patch" or "installed", got "${flow}"`)
        options.flow = flow
        break
      }
      case '--root': options.root = resolve(valueOf('--root')); break
      case '--port': {
        const port = Number(valueOf('--port'))
        if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer in [0, 65535]')
        options.port = port
        break
      }
      case '--no-build': options.build = false; break
      case '--no-worktree': options.worktree = false; break
      case '--verbose': options.verbose = true; break
      case '--help':
      case '-h':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Whether a path is an existing symbolic link. */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Run one command to completion, capturing its output unless it inherits stdio. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    timeout: options.timeoutMs ?? 300_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    const tail = output.length > 4_000 ? `\n…${output.slice(-4_000)}` : output.length === 0 ? '' : `\n${output}`
    throw new Error(`\`${command} ${args.join(' ')}\` failed with exit code ${String(result.status)}${tail}`)
  }
  return result
}

/** Create one fresh scratch directory tree. */
function prepareScratch(options) {
  const tmpRoot = resolve(tmpdir())
  const base = resolve(options.root ?? join(tmpRoot, `${SCRATCH_NAME}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`))
  const relativeToTmp = relative(tmpRoot, base)
  if (relativeToTmp.length === 0
    || relativeToTmp === '..'
    || relativeToTmp.startsWith('../')
    || relativeToTmp.startsWith('..\\')
    || isAbsolute(relativeToTmp)) {
    throw new Error(`the scratch root must be a child of ${tmpRoot}, got ${base}`)
  }
  if (existsSync(base)) {
    const baseStat = lstatSync(base)
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
      throw new Error(`the scratch root is not a plain directory: ${base}`)
    }
    // `--root` may point at a directory the caller already uses. Only delete a
    // root this harness created (or an empty one); a string-prefix check is not
    // containment and would otherwise let `--root` delete an unrelated tree.
    const entries = readdirSync(base)
    if (entries.length > 0 && !entries.includes(SCRATCH_MARKER)) {
      throw new Error(
        `refusing to delete existing --root ${base}: it does not carry the ${SCRATCH_MARKER} marker. `
        + 'Choose a fresh directory or remove it yourself.',
      )
    }
    rmSync(base, { recursive: true, force: true })
  }
  const paths = {
    base,
    home: join(base, 'home'),
    logs: join(base, 'logs'),
    workspace: join(base, 'workspace'),
    config: join(base, 'config'),
  }
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  // DSH's Workspace registry canonicalizes every path with `fs.realpath`, and
  // the scratch root may sit below a symlink (on macOS `/var` points at
  // `/private/var`). Canonicalize the scratch paths up front so Session cwds,
  // Workspace paths, and the Git assertions all describe the same spelling.
  for (const key of Object.keys(paths)) paths[key] = realpathSync(paths[key])
  paths.board = join(paths.base, 'board', 'board.json')
  writeFileSync(join(paths.base, SCRATCH_MARKER), 'created by scripts/e2e-smoke.mjs\n')
  return paths
}

/**
 * Initialize the scratch workspace as a real Git repository with one commit.
 *
 * The phase-2 experimental worktree service branches from the checkout's
 * `HEAD` and checks the branch out below `<repository root>/.agents/worktrees/`;
 * a plain directory makes every isolation attempt fail. The seed commit also
 * gives `baseCommit === git rev-parse HEAD` a stable value to assert.
 * @param paths - scratch paths (already canonical).
 */
function initScratchRepository(paths) {
  const cwd = paths.workspace
  run('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd })
  // A local identity and disabled commit signing keep the seed commit
  // independent of the machine's global Git configuration.
  run('git', ['config', 'user.name', 'DevLead E2E'], { cwd })
  run('git', ['config', 'user.email', 'devlead-e2e@example.invalid'], { cwd })
  run('git', ['config', 'commit.gpgsign', 'false'], { cwd })
  writeFileSync(join(cwd, '.gitignore'), '.agents/\n')
  writeFileSync(join(cwd, 'README.md'), '# DevLead E2E workspace\n\nSeed commit for the worktree-isolation phase.\n')
  run('git', ['add', '.gitignore', 'README.md'], { cwd })
  run('git', ['commit', '--quiet', '-m', 'chore: seed the DevLead E2E workspace'], { cwd })
}

/** Resolve the DSH CLI to boot. */
function resolveDshBinary() {
  const candidate = process.env['DSH_BIN']
  if (candidate !== undefined && candidate.length > 0) {
    if (!existsSync(candidate)) throw new Error(`DSH_BIN does not exist: ${candidate}`)
    return candidate
  }
  const probe = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  const found = probe.stdout?.trim() ?? ''
  if (found.length === 0) {
    throw new Error('no `dsh` CLI found on PATH; install the DeepSeek Harness app or set DSH_BIN')
  }
  return found
}

/** Read the CLI version and require the 0.2.x runtime line this suite targets. */
function requireDshVersion(dshBinary) {
  const result = spawnSync(dshBinary, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${dshBinary} --version failed: ${(result.stderr ?? '').trim()}`)
  const version = (result.stdout ?? '').trim()
  if (!/^0\.2\./u.test(version)) {
    throw new Error(`this suite targets DeepSeek Harness 0.2.x; the installed runtime reports ${version}`)
  }
  return version
}

/**
 * Whether one DSH version's default composition provides Agent Teams.
 *
 * The `@deepseek-ai/dsh-agent-team` package first shipped in 0.2.2-rc.2 and
 * `dsh-base` includes its two profile rows from rc.2; rc.1 has no Team service
 * at all. Unknown versions are assumed to support it (the probe's live report
 * remains the source of truth for a custom composition).
 * @param version - `dsh --version` output.
 * @returns whether Agent Teams is expected to be composed by default.
 */
function agentTeamsSupportedByVersion(version) {
  const match = /^0\.2\.2(?:-rc\.(\d+))?/u.exec(version.trim())
  if (match === null) return true
  const rc = match[1]
  return rc === undefined || Number(rc) >= 2
}

/** Build every plugin package so the overlay points at the current sources. */
function buildPackages(options) {
  if (!options.build) return
  run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { inherit: true })
}

/** Create the throwaway profile from the shipped Web template. */
function createProfile(paths, dshBinary) {
  run(dshBinary, [SCRATCH_NAME, '--from-default-profile', 'web', '--dump-config'], {
    cwd: paths.workspace,
    env: { ...process.env, DSH_HOME: paths.home },
  })
  if (!existsSync(join(paths.home, 'profiles', SCRATCH_NAME, 'package.json'))) {
    throw new Error(`profile creation produced no manifest under ${paths.home}`)
  }
}

/** Absolute directory of the throwaway profile. */
function profileDirectory(paths) {
  return join(paths.home, 'profiles', SCRATCH_NAME)
}

/**
 * Absolute path of the linked-root symlink `scripts/dev-patch.mjs` registers in
 * a profile: DeepSeek Harness app-boot treats a symlink under the active
 * profile's `node_modules` that points outside the profiles tree as a linked
 * root, and importers below it resolve every `peerDependencies` name to the
 * installation's runtime package instead of a second physical copy.
 * @param paths - scratch paths.
 * @returns the symlink path under the throwaway profile's `node_modules`.
 */
function repoLinkPath(paths) {
  return join(profileDirectory(paths), 'node_modules', REPO_LINK_NAME)
}

/**
 * Generate the `dev:patch` overlay through the documented script and verify the
 * script also registered the checkout as a linked root of the throwaway
 * profile, then copy the overlay into the scratch tree.
 * @param paths - scratch paths.
 * @returns path of the copied overlay.
 */
function writePatchOverlay(paths) {
  run(process.execPath, [
    join(ROOT, 'scripts', 'dev-patch.mjs'),
    '--profile', SCRATCH_NAME,
    '--dsh-home', paths.home,
  ], { inherit: true })
  const generated = join(ROOT, '.tmp', 'cordis.patch.yml')
  if (!existsSync(generated)) throw new Error(`dev-patch did not write ${generated}`)
  const linkPath = repoLinkPath(paths)
  if (!isSymlink(linkPath)) {
    throw new Error(`dev-patch did not register the checkout as a linked root at ${linkPath}`)
  }
  const copy = join(paths.config, 'devlead.patch.yml')
  writeFileSync(copy, readFileSync(generated))
  return copy
}

/** Install the suite through `scripts/install-profile.mjs` into the throwaway profile. */
function installProfile(paths) {
  run(process.execPath, [
    join(ROOT, 'scripts', 'install-profile.mjs'),
    '--profile', SCRATCH_NAME,
    '--dsh-home', paths.home,
  ], { inherit: true })
}

/**
 * Select the official experimental bundle that composes the Git worktree
 * capability in the throwaway profile.
 *
 * The bundle is part of the installed app's official-bundle inventory
 * (`@deepseek-ai/dsh-official-bundles` lists it as an optional bundle), so
 * app-boot resolves its layer from the installation at the next start: no
 * `pnpm install`, no package version edit, and no lockfile write happens here.
 * This runs after the phase-1 instance was stopped, so the manifest edit cannot
 * race a live HMR re-read.
 * @param paths - scratch paths.
 * @returns the selected bundle name.
 */
function enableWorktreeBundle(paths) {
  const manifestPath = join(profileDirectory(paths), 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must hold a JSON object`)
  }
  manifest.dsh ??= {}
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) {
    throw new Error(`${manifestPath} has a non-object dsh field; refusing to rewrite it`)
  }
  manifest.dsh.profile ??= {}
  if (manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object' || Array.isArray(manifest.dsh.profile)) {
    throw new Error(`${manifestPath} has a non-object dsh.profile field; refusing to rewrite it`)
  }
  const bundles = manifest.dsh.profile.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    throw new Error(`${manifestPath} has a non-array dsh.profile.bundles; refusing to guess`)
  }
  const nextBundles = Array.isArray(bundles) ? bundles : []
  if (!nextBundles.includes(WORKTREE_BUNDLE)) nextBundles.push(WORKTREE_BUNDLE)
  manifest.dsh.profile.bundles = nextBundles
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return WORKTREE_BUNDLE
}

/**
 * Link `scripts/e2e-probe` as a profile package under
 * `<profile>/node_modules/@yankeguo/`.
 *
 * The symlink points outside the profiles tree, so DeepSeek Harness app-boot
 * treats it as a linked root: the probe's `@deepseek-ai/*` peer dependencies
 * resolve to the installation's runtime modules, exactly like the suite's own
 * links in both loading flows. The `--patch` row then names the package by
 * specifier, which the Loader resolves from the profile directory.
 * @param paths - scratch paths.
 * @returns the probe package's linked path.
 */
function linkProbePackage(paths) {
  const scope = join(profileDirectory(paths), 'node_modules', '@yankeguo')
  mkdirSync(scope, { recursive: true })
  const linkPath = join(scope, PROBE_PACKAGE.replace(/^@[^/]+\//u, ''))
  const target = join(ROOT, 'scripts', 'e2e-probe')
  if (isSymlink(linkPath)) {
    const current = resolve(dirname(linkPath), readlinkSync(linkPath))
    if (current === target) return linkPath
    unlinkSync(linkPath)
  } else if (existsSync(linkPath)) {
    throw new Error(`${linkPath} exists and is not a symlink; remove it and rerun`)
  }
  symlinkSync(target, linkPath, 'dir')
  return linkPath
}

/**
 * Write the phase-2 `--patch` overlay that inserts the private probe row.
 *
 * Both loading flows apply `--patch` overlays after their bundle and user
 * layers, so the probe row loads after every devlead row. The patch flow also
 * passes its existing devlead overlay first; the installed flow passes only
 * this probe overlay (its suite rows come from the profile's bundle selection).
 * @param paths - scratch paths.
 * @returns path of the generated probe patch.
 */
function writeProbePatch(paths) {
  const linkName = PROBE_PACKAGE.replace(/^@[^/]+\//u, '')
  const text = [
    '# Generated by scripts/e2e-smoke.mjs (phase 2) — inserts the private E2E probe row.',
    `# The profile also needs the linked root "node_modules/@yankeguo/${linkName}" -> ${join(ROOT, 'scripts', 'e2e-probe')}.`,
    '- insert:',
    '    - id: devlead-e2e-probe',
    `      name: '${PROBE_PACKAGE}'`,
    '',
  ].join('\n')
  const patchPath = join(paths.config, 'devlead-e2e-probe.patch.yml')
  writeFileSync(patchPath, text)
  return patchPath
}

/** Configure one absolute scratch board path without touching a real profile. */
function writeBoardConfigPatch(paths) {
  const patchPath = join(paths.config, 'devlead-board.patch.yml')
  const text = [
    '# Generated by scripts/e2e-smoke.mjs — scratch-only board configuration.',
    '- id: devlead',
    '  config:',
    `    boardPath: ${JSON.stringify(paths.board)}`,
    '',
  ].join('\n')
  writeFileSync(patchPath, text)
  return patchPath
}

/** Build the child environment with provider/infrastructure credentials removed. */
function childEnvironment(paths) {
  const env = { ...process.env, DSH_HOME: paths.home }
  for (const name of Object.keys(env)) {
    if (SECRET_ENV_PATTERN.test(name)) delete env[name]
  }
  return env
}

/**
 * Spawn the isolated Web runtime with one composition's `--patch` overlays and
 * resolve its tokenized launch URL.
 * @param paths - scratch paths.
 * @param dshBinary - CLI to boot.
 * @param options - parsed command-line options (flow, port, verbose).
 * @param phase - phase descriptor: `label` names the log file and `patches` are
 *   the `--patch` overlays applied after the profile's bundle/user layers.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, logPath: string }>}
 *   spawned process, launch URL, and the log file receiving its output.
 */
async function startWeb(paths, dshBinary, options, phase) {
  const args = ['--profile', SCRATCH_NAME]
  for (const patchPath of phase.patches) args.push('--patch', patchPath)
  args.push('--no-open', '--host', '127.0.0.1', '--port', String(options.port))
  const logPath = join(paths.logs, phase.label === '' ? `web-${options.flow}.log` : `web-${options.flow}-${phase.label}.log`)
  const chunks = []
  const child = spawn(dshBinary, args, {
    cwd: paths.workspace,
    env: childEnvironment(paths),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /** Append one stream chunk to the in-memory log and the log file. */
  const record = (chunk) => {
    chunks.push(String(chunk))
    writeFileSync(logPath, chunks.join(''))
    if (options.verbose) process.stdout.write(String(chunk))
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  /** Resolve once the readiness line appears, or reject on exit/timeout. */
  const url = await new Promise((resolveUrl, rejectUrl) => {
    /** Stop consuming readiness signals. */
    const settle = () => {
      clearTimeout(timer)
      child.stdout.off('data', inspect)
      child.stderr.off('data', inspect)
      child.off('exit', onExit)
    }
    /** Inspect accumulated output for the launch URL. */
    const inspect = () => {
      const match = READY_PATTERN.exec(chunks.join(''))
      if (match === null || match[1] === undefined) return
      settle()
      resolveUrl(match[1])
    }
    /** Fail readiness when the process exits first. */
    const onExit = (code) => {
      settle()
      rejectUrl(new Error(`the Web runtime exited (code ${String(code)}) before becoming ready; see ${logPath}`))
    }
    const timer = setTimeout(() => {
      settle()
      // The caller never receives the child on this path, so it cannot stop it
      // later; tear the half-started runtime down here or leave an orphan.
      void stopInstance(child)
      rejectUrl(new Error(`the Web runtime did not become ready within ${READY_TIMEOUT_MS}ms; see ${logPath}`))
    }, READY_TIMEOUT_MS)
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.on('exit', onExit)
    inspect()
  })
  return { child, url, logPath }
}

/** Stop one spawned runtime, escalating to SIGKILL after a grace period. */
async function stopInstance(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await exited
  clearTimeout(force)
}

/** Minimal authenticated client of the isolated Web instance. */
class WebClient {
  /** Response cookie exchanged for the launch token. */
  #cookie = ''
  /** Monotonic request counter behind unique ids. */
  #sequence = 0

  /**
   * @param url - tokenized launch URL printed by the runtime.
   */
  constructor(url) {
    this.origin = new URL(url).origin
    this.url = url
  }

  /** Exchange the launch token for the signed browser cookie. */
  async login() {
    const response = await fetch(this.url, { redirect: 'manual' })
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(value => typeof value === 'string')
    await response.text().catch(() => undefined)
    const cookie = cookies.find(value => typeof value === 'string' && value.includes('='))
    if (response.status !== 303 && response.status !== 302) {
      throw new Error(`launch-token exchange answered HTTP ${response.status} instead of a redirect`)
    }
    if (cookie === undefined) throw new Error('launch-token exchange returned no usable Set-Cookie header')
    this.#cookie = cookie.split(';')[0].trim()
  }

  /** Produce one unique id for an RPC envelope or prompt request. */
  nextId(prefix) {
    this.#sequence += 1
    return `${SCRATCH_NAME}-${prefix}-${process.pid}-${this.#sequence}`
  }

  /** Read one JSON global emitted by the real webserver/index-inject pipeline. */
  async injectedGlobal(name) {
    const response = await fetch(`${this.origin}/`, { headers: { cookie: this.#cookie } })
    if (response.status !== 200) throw new Error(`GET / answered HTTP ${response.status}`)
    const html = await response.text()
    const marker = `globalThis[${JSON.stringify(name)}]`
    const markerIndex = html.indexOf(marker)
    const equalsIndex = markerIndex < 0 ? -1 : html.indexOf('=', markerIndex + marker.length)
    const scriptEnd = equalsIndex < 0 ? -1 : html.indexOf('</script>', equalsIndex)
    if (markerIndex < 0 || equalsIndex < 0 || scriptEnd < 0) {
      throw new Error(`index HTML does not carry the injected ${name} global`)
    }
    let jsonText = html.slice(equalsIndex + 1, scriptEnd).trim()
    if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1).trim()
    return JSON.parse(jsonText)
  }

  /** Read the index HTML and return the injected boot graph. */
  async bootGraph() {
    return await this.injectedGlobal('__DSH_BOOT__')
  }

  /**
   * List the JSON global names present in the index HTML, without requiring
   * any one of them. Used for negative injection assertions.
   * @returns every `globalThis["<name>"]` key the webserver emitted.
   */
  async injectedGlobalNames() {
    const response = await fetch(`${this.origin}/`, { headers: { cookie: this.#cookie } })
    if (response.status !== 200) throw new Error(`GET / answered HTTP ${response.status}`)
    const html = await response.text()
    return [...html.matchAll(/globalThis\["((?:[^"\\]|\\.)*)"\]/gu)]
      .map(match => JSON.parse(`"${match[1]}"`))
  }

  /**
   * Call one unary Remote method through the browser-facing HTTP bridge.
   * @param method - `<namespace>/<method>` endpoint.
   * @param args - named argument object.
   * @param timeoutMs - HTTP timeout for this call.
   */
  async rpc(method, args, timeoutMs = RPC_TIMEOUT_MS) {
    const rpcId = this.nextId('rpc')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.origin}/api/${method}`, {
        method: 'POST',
        headers: { cookie: this.#cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: controller.signal,
      })
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      let body = ''
      let envelope
      let form
      try {
        if (mediaType === 'multipart/form-data') {
          // workspaceFiles/readBytes uses DSH's binary RPC envelope: a JSON
          // metadata part plus Blob attachments whose paths point at null
          // placeholders in result.value. Rehydrate those bytes just like the
          // real browser client instead of trying to JSON.parse the raw body.
          form = await response.formData()
          const metadata = form.get('metadata')
          if (typeof metadata !== 'string') throw new Error('missing multipart metadata')
          envelope = JSON.parse(metadata)
        } else {
          body = await response.text()
          if (response.status !== 200) throw new Error(`${method} answered HTTP ${response.status}: ${body.slice(0, 300)}`)
          envelope = JSON.parse(body)
        }
      } catch (error) {
        throw new Error(`${method} returned an invalid RPC envelope (${messageOf(error)}): ${body.slice(0, 300)}`)
      }
      if (envelope?.result?.ok !== true) {
        const code = envelope?.result?.error?.code ?? 'unknown'
        const message = envelope?.result?.error?.message ?? body.slice(0, 300)
        throw new Error(`${method} failed: ${code}: ${message}`)
      }
      const value = envelope.result.value
      for (const attachment of envelope.attachments ?? []) {
        const data = form?.get(attachment.part)
        if (!(data instanceof Blob) || !Array.isArray(attachment.path) || attachment.path.length === 0) {
          throw new Error(`${method} returned an invalid binary attachment`)
        }
        let parent = value
        for (const segment of attachment.path.slice(0, -1)) parent = parent?.[segment]
        const key = attachment.path.at(-1)
        if ((typeof parent !== 'object' || parent === null) || parent[key] !== null) {
          throw new Error(`${method} returned an invalid binary attachment path`)
        }
        parent[key] = new Uint8Array(await data.arrayBuffer())
      }
      return value
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Create one ordinary Session in the scratch workspace, another directory, or
   * with no recorded workspace root (`cwd === null`).
   * @param paths - scratch paths.
   * @param cwd - Session workspace root; defaults to the scratch workspace.
   */
  async createSession(paths, cwd = paths.workspace) {
    return await this.rpc('session/create', { request: cwd === null ? {} : { cwd } })
  }

  /**
   * Execute one command line for a Session Agent.
   * @param agentId - calling Agent identity.
   * @param line - full command line, including the leading slash.
   * @param timeoutMs - HTTP timeout; probe commands may wait for a child turn.
   */
  async command(agentId, line, timeoutMs = RPC_TIMEOUT_MS) {
    return await this.rpc('commands/execute', { agentId, line, submittedAttachments: [] }, timeoutMs)
  }

  /** Read the Session projection map. */
  async projections(sessionId) {
    return await this.rpc('session/projections', { request: { sessionId } })
  }

  /** Read the Session-list summaries (the sidebar's data source). */
  async list() {
    // `session/list` names its (empty) request argument `_request`.
    return await this.rpc('session/list', { _request: {} })
  }
}

/** One assertion record. */
class Checks {
  /** Every check result, in execution order. */
  results = []

  /** Record one check and print it. */
  expect(name, condition, detail) {
    const ok = Boolean(condition)
    this.results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
    return ok
  }

  /**
   * Record one check that could not be exercised in this Host composition.
   * Skips count as passed so the phase total stays stable, but they print
   * `SKIP` with the reason instead of pretending the assertion ran.
   * @param name - check name.
   * @param reason - why the check could not run.
   */
  skip(name, reason) {
    this.results.push({ name, ok: true, skipped: true })
    console.log(`SKIP ${name} :: ${reason}`)
  }

  /**
   * Fail with the collected check list when anything failed, and pin the
   * phase total: a deleted or silently dropped check changes the count and
   * fails the phase even when every remaining check passes. PASS and SKIP
   * are reported separately; skips still count toward the pinned total.
   * @param expected - pinned check total of this phase ({@link EXPECTED_CHECKS}).
   */
  summarize(expected) {
    const failed = this.results.filter(result => !result.ok)
    const skipped = this.results.filter(result => result.skipped === true).length
    const passed = this.results.length - failed.length - skipped
    console.log(`\n${String(passed)} PASS + ${String(skipped)} SKIP = ${String(this.results.length)} checks (expected ${String(expected)})`)
    if (this.results.length !== expected) {
      throw new Error(`check count drift: expected ${String(expected)} checks, ran ${String(this.results.length)} (a check was deleted or added without updating EXPECTED_CHECKS)`)
    }
    if (failed.length > 0) throw new Error(`failed checks: ${failed.map(result => result.name).join(', ')}`)
  }
}

/** Wait until `read` yields a value or the timeout elapses. */
async function waitFor(read, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined && value !== null) return value
    if (Date.now() >= deadline) return undefined
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
}

/**
 * Run every phase-1 product check against the default-composition instance.
 *
 * Stops before the final `/devlead status` + `/devlead off` checks: those run
 * in phase 1b against the restarted Host, so the durable state (enabled mode,
 * watch set, notification digest) survives for the rehydration assertions.
 * @param client - authenticated client of the phase-1 instance.
 * @param paths - scratch paths.
 * @returns the check count and the durable identities phase 1b continues with.
 */
async function runChecks(client, paths) {
  const checks = new Checks()
  await client.login()

  const boot = await client.bootGraph()
  const clientEntry = (boot.entries ?? []).find(entry => entry.id === '@yankeguo/dsh-client-ui-devlead')
  checks.expect('boot graph carries the DevLead client plugin', clientEntry !== undefined, clientEntry?.url)
  const inject = clientEntry?.inject ?? []
  checks.expect(
    'client plugin declares its package.json injects',
    inject.includes('@deepseek-ai/dsh-api-remotes') && inject.includes('@deepseek-ai/dsh-client-ui-primitives'),
    `${String(inject.length)} injects`,
  )
  // The board tab/button/global are gated by lead activation, not by the static
  // inject table (the DSH client loader needs the table at boot). With no active
  // lead this default composition must publish no global.
  const globalNames = await client.injectedGlobalNames()
  checks.expect(
    'disabled board publishes no global while its client injects stay declared',
    !globalNames.includes('__DSH_DEVLEAD_BOARD__')
      && inject.includes('@deepseek-ai/dsh-api-workspace-files')
      && inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'),
    `${String(globalNames.length)} globals; board injects declared: ${
      String(inject.includes('@deepseek-ai/dsh-api-workspace-files'))}`,
  )

  const lead = await client.createSession(paths)
  const leadId = lead.sessionId
  checks.expect('session/create returns a lead Session', typeof leadId === 'string' && leadId.length > 0, leadId)

  const commands = await client.rpc('commands/list', { agentId: leadId })
  const devlead = commands.find(command => command.name === 'devlead')
  checks.expect('/devlead command is registered', devlead !== undefined, devlead?.input?.hint)
  checks.expect('/devlead advertises its grammar', typeof devlead?.description === 'string' && devlead.description.length > 0)

  const projection0 = (await client.projections(leadId))?.values?.devLead
  checks.expect('devLead projection is registered', projection0 !== undefined)
  checks.expect(
    'devLead projection defaults to disabled',
    projection0?.enabled === false && Array.isArray(projection0?.sessions) && Array.isArray(projection0?.notifications),
  )

  const mode0 = (await client.projections(leadId))?.values?.devLeadMode
  checks.expect('summary-sized devLeadMode projection is registered', mode0 !== undefined)
  checks.expect('devLeadMode projection defaults to disabled', mode0?.enabled === false)
  const list0 = await client.list()
  const row0 = (list0?.items ?? []).find(item => item.sessionId === leadId)
  checks.expect(
    'Session-list summary row carries devLeadMode',
    row0?.projections?.values?.devLeadMode?.enabled === false,
    JSON.stringify(row0?.projections?.values?.devLeadMode),
  )
  checks.expect(
    'Session-list summary excludes the digest-bearing devLead projection',
    row0?.projections?.values?.devLead === undefined,
    JSON.stringify(row0?.projections?.values?.devLead ?? null),
  )

  const on = await client.command(leadId, '/devlead on')
  checks.expect('/devlead on settles success', on?.result?.kind === 'success', on?.result?.text?.split('\n')[0])
  checks.expect('/devlead on reports the enabled mode', /DevLead mode enabled\./u.test(on?.result?.text ?? ''))
  const projection1 = (await client.projections(leadId))?.values?.devLead
  checks.expect('projection reports enabled after /devlead on', projection1?.enabled === true)
  const mode1 = (await client.projections(leadId))?.values?.devLeadMode
  checks.expect('devLeadMode projection reports enabled after /devlead on', mode1?.enabled === true)
  const list1 = await client.list()
  const row1 = (list1?.items ?? []).find(item => item.sessionId === leadId)
  checks.expect(
    'Session-list summary row follows /devlead on',
    row1?.projections?.values?.devLeadMode?.enabled === true,
    JSON.stringify(row1?.projections?.values?.devLeadMode),
  )

  // The board needs no configuration: the active lead's original workspace
  // root owns `.dsh/devlead/board.json`, and the Host publishes that derived
  // path (plus the lead identity) in the index global.
  const defaultBoardPath = derivedBoardPath(paths.workspace)
  const boardGlobal = await client.injectedGlobal('__DSH_DEVLEAD_BOARD__')
  checks.expect(
    'default board global follows the lead workspace without configuration',
    boardGlobal?.boardPath === defaultBoardPath
      && boardGlobal?.leadSessionId === leadId
      && boardGlobal?.override === false
      && boardGlobal?.schemaVersion === 1
      && boardGlobal?.pathPlatform === (process.platform === 'win32' ? 'win32' : 'posix'),
    JSON.stringify(boardGlobal),
  )
  checks.expect(
    'enabling the lead precreates the derived board parent directory',
    existsSync(join(paths.workspace, '.dsh', 'devlead')),
    join(paths.workspace, '.dsh', 'devlead'),
  )

  const status = await client.command(leadId, '/devlead status')
  checks.expect('/devlead status prints the enabled mode', /DevLead mode: on/u.test(status?.result?.text ?? ''))
  // The throwaway profile is the shipped default Web composition (base +
  // web-app): it must not carry the experimental worktree bundle. DevLead has
  // to report the missing optional capability and still work normally.
  checks.expect(
    'default profile reports no optional worktree isolation',
    /Worktree isolation: unavailable/u.test(status?.result?.text ?? ''),
    status?.result?.text?.split('\n').find(line => line.startsWith('Worktree isolation:'))
      ?? 'no Worktree isolation line',
  )

  const selfWatch = await client.command(leadId, `/devlead watch ${leadId}`)
  checks.expect('self watch settles as a command error', selfWatch?.result?.kind === 'error', selfWatch?.result?.text)
  checks.expect('self watch explains the rule', /cannot watch itself/u.test(selfWatch?.result?.text ?? ''))

  const child = await client.createSession(paths)
  const childId = child.sessionId
  checks.expect('session/create returns a child Session', typeof childId === 'string' && childId.length > 0, childId)
  const watch = await client.command(leadId, `/devlead watch ${childId}`)
  checks.expect('watching a real child Session succeeds', watch?.result?.kind === 'success', watch?.result?.text?.split('\n')[0])
  const projection2 = (await client.projections(leadId))?.values?.devLead
  checks.expect('projection carries the watched child', (projection2?.sessions ?? []).includes(childId))

  const prompt = await client.rpc('session/prompt', {
    request: {
      requestId: client.nextId('prompt'),
      sessionId: childId,
      mode: 'queue',
      content: [{ type: 'text', text: 'devlead e2e smoke: this turn is expected to settle as a provider error' }],
    },
  })
  checks.expect('child Session admits a prompt', prompt?.accepted === true)
  await client.rpc(
    'session/wait',
    { request: { sessionId: childId, timeoutMs: TURN_TIMEOUT_MS } },
    TURN_TIMEOUT_MS + 15_000,
  )

  const notification = await waitFor(async () => {
    const projection = (await client.projections(leadId))?.values?.devLead
    const latest = (projection?.notifications ?? []).at(-1)
    return latest?.sessionId === childId ? latest : undefined
  }, NOTIFICATION_TIMEOUT_MS)
  checks.expect('watched child turn/end notifies the lead projection', notification !== undefined, notification?.id)
  checks.expect('notification carries a stable identity', NOTIFICATION_ID_PATTERN.test(notification?.id ?? ''))
  checks.expect(
    'notification records the provider failure',
    notification?.transition === 'error' && typeof notification?.error === 'string' && notification.error.length > 0,
    notification?.error?.slice(0, 120),
  )

  checks.summarize(EXPECTED_CHECKS.phase1)
  // The restart phase continues against the same durable Sessions; hand over
  // every identity its assertions need. The final `/devlead status` and
  // `/devlead off` checks deliberately run there: they exercise the lead after
  // the restarted Host has rehydrated it (and after a cold wake resumed it), so
  // the phase-1 instance is stopped with DevLead mode still enabled.
  return {
    count: checks.results.length,
    leadId,
    childId,
    notificationId: notification?.id,
  }
}

/**
 * Run the phase-1b cold-rehydration checks against a restarted Host.
 *
 * Phase 1 leaves the lead Session DevLead-enabled with one watched child and
 * one durable turn-1 notification, then stops the Host. This phase boots the
 * SAME composition against the SAME scratch home and verifies the D2 behavior
 * that unit tests can only fake:
 *
 *   - the cold lead's projection still folds from the durable log without
 *     activating the Session (mode, watch set, notification digest);
 *   - a second prompt resumes the cold child, and its turn-2 `turn/end` reaches
 *     the lead only when the hub rebuilt its watch index from persisted records
 *     (rehydrate) and resumed the cold lead to persist + deliver the wake
 *     (`wakeColdSession` defaults to true);
 *   - the resumed, now-live lead answers `/devlead status` and the final
 *     `/devlead off` (moved here because disabling must happen on this
 *     instance).
 * @param client - authenticated client of the restarted instance.
 * @param paths - scratch paths (unused identities aside, kept for symmetry).
 * @param state - identities handed over by phase 1.
 * @returns the number of checks performed.
 */
async function runRehydrationChecks(client, paths, state) {
  void paths
  const checks = new Checks()
  await client.login()
  const { leadId, childId, notificationId } = state

  // `session/projections` serves a cold Session's projected values from the
  // durable log without activating it, so this read is the direct evidence
  // that the projection fold survived the restart.
  const coldProjection = (await client.projections(leadId))?.values?.devLead
  checks.expect(
    'restarted Host still reports the cold lead as DevLead-enabled',
    coldProjection?.enabled === true,
    JSON.stringify(coldProjection?.enabled),
  )
  checks.expect(
    'restarted Host still folds the watched child into the cold lead set',
    (coldProjection?.sessions ?? []).includes(childId),
    JSON.stringify(coldProjection?.sessions),
  )
  checks.expect(
    'the cold lead projection retains the first-turn notification after restart',
    (coldProjection?.notifications ?? []).some(notification => notification.id === notificationId),
    JSON.stringify((coldProjection?.notifications ?? []).map(notification => notification.id)),
  )

  // The board follows the cold lead too: its persisted header cwd is enough,
  // no resume and no page-load lead activity is required.
  // Rehydration may finish shortly after boot; poll the index injection rather
  // than asserting on a single early request.
  const coldBoardGlobal = await waitFor(async () => {
    try {
      return await client.injectedGlobal('__DSH_DEVLEAD_BOARD__')
    } catch {
      return undefined
    }
  }, 10_000)
  checks.expect(
    'restarted Host derives the cold lead board path from its persisted header',
    coldBoardGlobal?.boardPath === derivedBoardPath(paths.workspace)
      && coldBoardGlobal?.leadSessionId === leadId
      && coldBoardGlobal?.override === false,
    JSON.stringify(coldBoardGlobal),
  )

  const prompt = await client.rpc('session/prompt', {
    request: {
      requestId: client.nextId('rehydrate-prompt'),
      sessionId: childId,
      mode: 'queue',
      content: [{ type: 'text', text: 'devlead e2e smoke: second turn after a Host restart, expected to settle as a provider error' }],
    },
  })
  checks.expect('cold child Session accepts a second prompt after restart', prompt?.accepted === true)
  await client.rpc(
    'session/wait',
    { request: { sessionId: childId, timeoutMs: TURN_TIMEOUT_MS } },
    TURN_TIMEOUT_MS + 15_000,
  )

  // This notification only exists when (a) the hub rebuilt the lead's watch
  // index from durable state at startup, and (b) the cold lead was resumed and
  // the unsaved notification was persisted + delivered. A cold Host that forgot
  // the watch index, or a `wakeColdSession: false` regression, both time out.
  const restartNotification = await waitFor(async () => {
    const projection = (await client.projections(leadId))?.values?.devLead
    const latest = (projection?.notifications ?? []).at(-1)
    return latest?.sessionId === childId && latest.id !== notificationId ? latest : undefined
  }, COLD_NOTIFICATION_TIMEOUT_MS)
  checks.expect('restarted Host wakes on the watched cold child turn/end', restartNotification !== undefined, restartNotification?.id)
  checks.expect(
    'the restart notification is the second-turn provider failure',
    restartNotification?.turn === 2
      && restartNotification?.transition === 'error'
      && restartNotification?.id === `${childId}:2:error`,
    `${String(restartNotification?.turn)}:${String(restartNotification?.transition)}`,
  )

  // The cold wake resumed the lead Agent; the remaining phase-1 tail now runs
  // against the live lead on the restarted Host.
  const statusAfter = await client.command(leadId, '/devlead status')
  checks.expect('/devlead status lists the recent notification', /Recent notifications:/u.test(statusAfter?.result?.text ?? ''))
  checks.expect('/devlead status lists the watched child', (statusAfter?.result?.text ?? '').includes(childId))

  const off = await client.command(leadId, '/devlead off')
  checks.expect('/devlead off settles success', off?.result?.kind === 'success', off?.result?.text?.split('\n')[0])
  checks.expect('/devlead off reports the disabled mode', /DevLead mode disabled\./u.test(off?.result?.text ?? ''))
  const projection3 = (await client.projections(leadId))?.values?.devLead
  checks.expect('projection reports disabled after /devlead off', projection3?.enabled === false)
  const mode3 = (await client.projections(leadId))?.values?.devLeadMode
  checks.expect('devLeadMode projection reports disabled after /devlead off', mode3?.enabled === false)
  const globalsAfterOff = await client.injectedGlobalNames()
  checks.expect(
    'disabling the lead removes the board global',
    !globalsAfterOff.includes('__DSH_DEVLEAD_BOARD__'),
    JSON.stringify(globalsAfterOff),
  )

  // A lead in another workspace owns another board file: switching the lead
  // switches the derived path with no configuration and no restart.
  const workspaceB = join(paths.base, 'workspace-b')
  mkdirSync(workspaceB, { recursive: true })
  const leadB = await client.createSession(paths, workspaceB)
  const leadBId = leadB.sessionId
  const onB = await client.command(leadBId, '/devlead on')
  checks.expect(
    'workspace-B lead enables DevLead mode',
    onB?.result?.kind === 'success' && /DevLead mode enabled\./u.test(onB?.result?.text ?? ''),
    onB?.result?.text?.split('\n')[0],
  )
  const boardGlobalB = await client.injectedGlobal('__DSH_DEVLEAD_BOARD__')
  checks.expect(
    'switching the lead workspace switches the derived board path',
    boardGlobalB?.boardPath === derivedBoardPath(workspaceB) && boardGlobalB?.leadSessionId === leadBId,
    JSON.stringify(boardGlobalB),
  )
  checks.expect(
    'workspace-B lead precreates its own board parent directory',
    existsSync(join(workspaceB, '.dsh', 'devlead')),
    join(workspaceB, '.dsh', 'devlead'),
  )
  const offB = await client.command(leadBId, '/devlead off')
  checks.expect(
    'workspace-B lead releases the global slot',
    offB?.result?.kind === 'success' && /DevLead mode disabled\./u.test(offB?.result?.text ?? ''),
    offB?.result?.text?.split('\n')[0],
  )

  checks.summarize(EXPECTED_CHECKS.phase1b)
  return checks.results.length
}

/**
 * Capture one Git invocation's output for the phase-2 assertions.
 * @param cwd - repository directory the command runs against.
 * @param args - arguments after `git -C <cwd>`.
 * @returns the completed child process (`status`/`stdout`/`stderr`).
 */
function gitResult(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

/**
 * Run the phase-2 worktree-isolation checks against the experimental
 * composition.
 *
 * The probe command performs the Host-side actions (`useWorkspace` +
 * `createSession({ isolation: 'worktree' })`) and reports its result as JSON;
 * this function only compares that report against independent facts: the
 * filesystem, Git itself, and the Workspace/Session identity the result
 * carries. No new Remote API is involved.
 * @param client - authenticated client of the phase-2 instance.
 * @param paths - scratch paths; `paths.workspace` is the seeded Git repository.
 * @returns the number of checks performed.
 */
async function runWorktreeChecks(client, paths) {
  const checks = new Checks()
  await client.login()

  const lead = await client.createSession(paths)
  const leadId = lead.sessionId
  checks.expect('phase 2 session/create returns a lead Session', typeof leadId === 'string' && leadId.length > 0, leadId)

  const commands = await client.rpc('commands/list', { agentId: leadId })
  const probeCommand = commands.find(command => command.name === PROBE_COMMAND)
  checks.expect('probe command is registered', probeCommand !== undefined, probeCommand?.description)

  const on = await client.command(leadId, '/devlead on')
  checks.expect('phase 2 /devlead on settles success', on?.result?.kind === 'success', on?.result?.text?.split('\n')[0])

  // This composition carries the scratch boardPath overlay: the configured
  // path must win over the workspace derivation and be published as such.
  const overrideGlobal = await client.injectedGlobal('__DSH_DEVLEAD_BOARD__')
  checks.expect(
    'configured boardPath override wins over the lead workspace derivation',
    overrideGlobal?.boardPath === paths.board
      && overrideGlobal?.override === true
      && overrideGlobal?.leadSessionId === leadId,
    JSON.stringify(overrideGlobal),
  )

  const status = await client.command(leadId, '/devlead status')
  checks.expect(
    'experimental composition reports worktree isolation available',
    /Worktree isolation: available/u.test(status?.result?.text ?? ''),
    status?.result?.text?.split('\n').find(line => line.startsWith('Worktree isolation:'))
      ?? 'no Worktree isolation line',
  )

  const probeExecution = await client.command(leadId, `/${PROBE_COMMAND}`)
  const probeText = probeExecution?.result?.text ?? ''
  const probeSucceeded = probeExecution?.result?.kind === 'success'
  checks.expect('probe command settles success', probeSucceeded, probeSucceeded ? undefined : probeText.slice(0, 500))
  let answer
  try {
    answer = JSON.parse(probeText)
  } catch {
    answer = undefined
  }
  checks.expect(
    'probe returns the created/child JSON contract',
    typeof answer === 'object' && answer !== null
      && typeof answer.created === 'object' && answer.created !== null
      && typeof answer.child === 'object' && answer.child !== null,
  )

  const created = answer?.created ?? {}
  const child = answer?.child ?? {}
  const isolation = created.isolation ?? {}
  const workspace = created.workspace ?? {}
  const isolationPath = typeof isolation.path === 'string' ? isolation.path : ''
  const repositoryRoot = paths.workspace
  const worktreeRoot = join(repositoryRoot, WORKTREE_DIRECTORY)

  // The isolation outcome the Host reported.
  checks.expect('isolation reports the requested worktree mode', isolation.requested === 'worktree', isolation.requested)
  checks.expect('isolation reports a created worktree', isolation.status === 'worktree', isolation.status)
  checks.expect('isolation reports a checkout path', isolationPath.length > 0, isolation.path)
  checks.expect('isolation reports a branch', typeof isolation.branch === 'string' && isolation.branch.length > 0, isolation.branch)
  checks.expect('isolation reports a base commit', typeof isolation.baseCommit === 'string' && isolation.baseCommit.length > 0, isolation.baseCommit)
  checks.expect('the checkout directory exists', isolationPath.length > 0 && existsSync(isolationPath), isolationPath)
  checks.expect(
    'the checkout is inside the workspace worktree pool',
    isolationPath.length > 0 && isolationPath.startsWith(`${worktreeRoot}${sep}`),
    `${isolationPath} inside ${worktreeRoot}`,
  )

  // The real Git facts an independent reviewer can verify.
  const head = gitResult(repositoryRoot, ['rev-parse', 'HEAD'])
  checks.expect(
    'isolation baseCommit equals the repository HEAD',
    head.status === 0 && head.stdout.trim() === isolation.baseCommit,
    head.status === 0 ? `${head.stdout.trim()} vs ${String(isolation.baseCommit)}` : head.stderr.trim(),
  )
  const worktreeList = gitResult(repositoryRoot, ['worktree', 'list', '--porcelain'])
  checks.expect(
    'git worktree list registers the checkout',
    worktreeList.status === 0 && worktreeList.stdout.split('\n').includes(`worktree ${isolationPath}`),
    worktreeList.status === 0 ? isolationPath : worktreeList.stderr.trim(),
  )
  const branchRef = gitResult(repositoryRoot, ['show-ref', '--verify', `refs/heads/${String(isolation.branch)}`])
  checks.expect(
    'the isolation branch ref exists',
    branchRef.status === 0,
    branchRef.status === 0 ? String(isolation.branch) : branchRef.stderr.trim(),
  )

  // The child Session's header and effective directories are different facts:
  // isolation moves the effective directory only, never the project header.
  checks.expect(
    'probe reports the created child Session id',
    typeof child.sessionId === 'string' && child.sessionId === created.session?.sessionId,
    `${String(child.sessionId)} vs ${String(created.session?.sessionId)}`,
  )
  checks.expect(
    "child Session's effective cwd is the worktree checkout",
    isolationPath.length > 0 && child.effectiveCwd === isolationPath,
    `${String(child.effectiveCwd)} vs ${isolationPath}`,
  )
  checks.expect(
    "child Session's header cwd stays the workspace",
    child.headerCwd === repositoryRoot,
    `${String(child.headerCwd)} vs ${repositoryRoot}`,
  )

  // Workspace membership the created result must prove.
  checks.expect(
    'created Session belongs to a Workspace',
    typeof created.session?.workspaceId === 'string' && created.session.workspaceId.length > 0,
    created.session?.workspaceId,
  )
  checks.expect(
    'created Session belongs to the registered Workspace',
    typeof created.session?.workspaceId === 'string'
      && created.session.workspaceId === workspace.workspaceId
      && typeof workspace.workspaceId === 'string' && workspace.workspaceId.length > 0,
    `${String(created.session?.workspaceId)} vs ${String(workspace.workspaceId)}`,
  )
  checks.expect(
    'the registered Workspace is the scratch workspace',
    workspace.path === repositoryRoot,
    `${String(workspace.path)} vs ${repositoryRoot}`,
  )

  // DevLead mode is globally single-active: phase 3 starts a new lead against
  // the same durable scratch home, so this phase must release its slot.
  const off = await client.command(leadId, '/devlead off')
  checks.expect(
    'phase 2 /devlead off releases the global slot',
    off?.result?.kind === 'success' && /DevLead mode disabled\./u.test(off?.result?.text ?? ''),
    off?.result?.text?.split('\n')[0],
  )

  checks.summarize(EXPECTED_CHECKS.phase2)
  return checks.results.length
}

/**
 * Run one probe command and parse its JSON report.
 * @param client - authenticated client of the running instance.
 * @param agentId - lead Agent identity the command runs for.
 * @param command - probe command name, without the leading slash.
 * @param timeoutMs - HTTP timeout for the command.
 * @returns the command execution, raw text, and parsed JSON (undefined when not JSON).
 */
async function runProbeCommand(client, agentId, command, timeoutMs = RPC_TIMEOUT_MS) {
  const execution = await client.command(agentId, `/${command}`, timeoutMs)
  const text = execution?.result?.text ?? ''
  let report
  try {
    report = JSON.parse(text)
  } catch {
    report = undefined
  }
  return { execution, text, report }
}

/**
 * Run the phase-3 close-tool checks against the real Host.
 *
 * The private probe drives every durable action through `ctx.devLead` and
 * reports facts read back from the Workspace registry, the Session store, and
 * the durable Session query engine. The harness compares those facts with
 * independent ones (the scratch filesystem and the exact tool/policy text a
 * real step admits), so a fake or a stale in-memory answer cannot pass.
 * @param client - authenticated client of the phase-3 instance.
 * @param paths - scratch paths; `paths.workspace` is the scratch Workspace.
 * @param dshVersion - running DSH version, used to expect Team availability by default.
 * @returns the number of checks performed.
 */
async function runCloseChecks(client, paths, dshVersion) {
  const checks = new Checks()
  await client.login()

  const lead = await client.createSession(paths)
  const leadId = lead.sessionId
  checks.expect('phase 3 session/create returns a lead Session', typeof leadId === 'string' && leadId.length > 0, leadId)

  const commands = await client.rpc('commands/list', { agentId: leadId })
  const inspectCommand = commands.find(command => command.name === PROBE_INSPECT_COMMAND)
  const closeCommand = commands.find(command => command.name === PROBE_CLOSE_COMMAND)
  const boardCommand = commands.find(command => command.name === PROBE_BOARD_COMMAND)
  const dispatchCommand = commands.find(command => command.name === PROBE_DISPATCH_COMMAND)
  checks.expect('phase 3 inspect probe command is registered', inspectCommand !== undefined, inspectCommand?.description)
  checks.expect('phase 3 close probe command is registered', closeCommand !== undefined, closeCommand?.description)
  checks.expect('phase 3 board probe command is registered', boardCommand !== undefined, boardCommand?.description)
  checks.expect('phase 3 dispatch probe command is registered', dispatchCommand !== undefined, dispatchCommand?.description)

  // Mode off: the conditional registration must hide every devlead tool and
  // resolve the policy section to empty text.
  const inspectOff = await runProbeCommand(client, leadId, PROBE_INSPECT_COMMAND)
  checks.expect(
    'phase 3 mode-off inspect settles success',
    inspectOff.execution?.result?.kind === 'success',
    inspectOff.text.slice(0, 300),
  )
  checks.expect(
    'phase 3 mode-off inspect reports disabled',
    inspectOff.report?.enabled === false,
    JSON.stringify(inspectOff.report?.enabled),
  )
  checks.expect(
    'phase 3 mode-off hides every devlead tool',
    Array.isArray(inspectOff.report?.devleadTools) && inspectOff.report.devleadTools?.length === 0,
    JSON.stringify(inspectOff.report?.devleadTools),
  )
  checks.expect(
    'phase 3 mode-off omits the devlead policy section',
    inspectOff.report?.policy == null || String(inspectOff.report.policy).trim().length === 0,
    JSON.stringify(inspectOff.report?.policy),
  )

  const on = await client.command(leadId, '/devlead on')
  checks.expect('phase 3 /devlead on settles success', on?.result?.kind === 'success', on?.result?.text?.split('\n')[0])

  const derivedBoard = derivedBoardPath(paths.workspace)
  const board = await runProbeCommand(client, leadId, PROBE_BOARD_COMMAND)
  checks.expect(
    'phase 3 real board create + CAS + path/title refs + Host read-back succeed',
    board.execution?.result?.kind === 'success'
      && board.report?.created?.revision === 1
      && board.report?.updated?.revision === 2
      && board.report?.byPath?.revision === 3
      && board.report?.byTitle?.revision === 4
      && board.report?.detail?.revision === 4
      && board.report?.created?.project?.tasks === undefined
      && board.report?.updated?.project?.tasks === undefined
      && board.report?.byTitle?.project?.next === 'updated through the workspace title'
      && board.report?.detail?.projects?.[0]?.tasks?.length === 1,
    board.text.slice(0, 500),
  )
  checks.expect(
    'phase 3 board reports the derived workspace path and the lead identity',
    board.report?.boardPath === derivedBoard
      && board.report?.boardLeadSessionId === leadId
      && board.report?.boardOverride === false,
    JSON.stringify({
      boardPath: board.report?.boardPath,
      boardLeadSessionId: board.report?.boardLeadSessionId,
      boardOverride: board.report?.boardOverride,
    }),
  )
  const boardGlobal = await client.injectedGlobal('__DSH_DEVLEAD_BOARD__')
  checks.expect(
    'phase 3 webserver/index-inject publishes the derived board global',
    boardGlobal?.boardPath === derivedBoard
      && boardGlobal?.leadSessionId === leadId
      && boardGlobal?.override === false
      && boardGlobal?.schemaVersion === 1
      && boardGlobal?.pathPlatform === (process.platform === 'win32' ? 'win32' : 'posix'),
    JSON.stringify(boardGlobal),
  )
  const persistedBoard = existsSync(derivedBoard)
    ? JSON.parse(readFileSync(derivedBoard, 'utf8'))
    : undefined
  checks.expect(
    'phase 3 board disk bytes carry revision 4, the CAS focus, the ref updates, and the task',
    persistedBoard?.revision === 4
      && persistedBoard?.projects?.[0]?.focus === 'CAS committed through the real Host'
      && persistedBoard?.projects?.[0]?.next === 'updated through the workspace title'
      && persistedBoard?.projects?.[0]?.tasks?.[0]?.id === 'task-1',
    JSON.stringify({ revision: persistedBoard?.revision, project: persistedBoard?.projects?.[0] }).slice(0, 500),
  )

  checks.expect(
    'phase 3 real notes create + append + project references + bounded summary succeed',
    board.report?.noteCreated?.revision === 1
      && board.report?.noteAppended?.revision === 2
      && board.text.includes('verify automatic refresh')
      && String(board.report?.boardSummary ?? '').includes('E2E implementation plan'),
    board.text.slice(-900),
  )
  const notesIndexPath = derivedNotesIndexPath(paths.workspace)
  const persistedNotesIndex = existsSync(notesIndexPath)
    ? JSON.parse(readFileSync(notesIndexPath, 'utf8'))
    : undefined
  const persistedNoteProject = persistedNotesIndex?.projects?.find(project => project.id === 'e2e-board')
  const persistedNote = persistedNoteProject?.notes?.find(note => note.id === 'e2e-plan')
  const notePath = persistedNote?.path === undefined
    ? undefined
    : join(dirname(notesIndexPath), ...String(persistedNote.path).split('/'))
  const persistedMarkdown = notePath !== undefined && existsSync(notePath)
    ? readFileSync(notePath, 'utf8')
    : undefined
  checks.expect(
    'phase 3 notes index and markdown disk bytes agree after atomic Host writes',
    persistedNotesIndex?.schemaVersion === 1
      && persistedNotesIndex?.revision === 2
      && persistedNote?.title === 'E2E implementation plan'
      && persistedNote?.bytes === Buffer.byteLength(persistedMarkdown ?? '', 'utf8')
      && persistedMarkdown?.includes('# E2E implementation plan')
      && persistedMarkdown?.includes('## Next'),
    JSON.stringify({ index: persistedNotesIndex, notePath, markdown: persistedMarkdown }).slice(0, 700),
  )
  const remoteIndexStat = await client.rpc('workspaceFiles/stat', {
    workspaceFileScopeId: leadId,
    path: notesIndexPath,
  })
  const remoteNoteStat = notePath === undefined ? undefined : await client.rpc('workspaceFiles/stat', {
    workspaceFileScopeId: leadId,
    path: notePath,
  })
  checks.expect(
    'phase 3 browser-facing workspaceFiles can stat the notes index and current note',
    remoteIndexStat?.absolutePath === notesIndexPath
      && remoteIndexStat?.bytes === readFileSync(notesIndexPath).byteLength
      && remoteNoteStat?.absolutePath === notePath
      && remoteNoteStat?.bytes === persistedNote?.bytes,
    JSON.stringify({ remoteIndexStat, remoteNoteStat }),
  )
  const remoteIndex = JSON.parse(decodeRemoteBytes(await client.rpc('workspaceFiles/readBytes', {
    workspaceFileScopeId: leadId,
    path: notesIndexPath,
    options: {},
  })))
  checks.expect(
    'phase 3 browser-facing readBytes returns the committed notes index',
    remoteIndex?.revision === 2
      && remoteIndex?.projects?.[0]?.id === 'e2e-board'
      && remoteIndex?.projects?.[0]?.notes?.[0]?.path === persistedNote?.path,
    JSON.stringify(remoteIndex).slice(0, 600),
  )
  const remoteMarkdown = decodeRemoteBytes(await client.rpc('workspaceFiles/readBytes', {
    workspaceFileScopeId: leadId,
    path: notePath,
    options: {},
  }))
  checks.expect(
    'phase 3 browser-facing readBytes returns complete markdown for the client reader',
    remoteMarkdown === persistedMarkdown && remoteMarkdown.includes('Read-only in the browser.'),
    remoteMarkdown.slice(0, 500),
  )

  // Mode on: a real tool activation and prompt assembly for this Agent.
  const inspectOn = await runProbeCommand(client, leadId, PROBE_INSPECT_COMMAND)
  checks.expect(
    'phase 3 enabled inspect settles success',
    inspectOn.execution?.result?.kind === 'success',
    inspectOn.text.slice(0, 300),
  )
  checks.expect(
    'phase 3 enabled inspect reports enabled and publishes notes through systemPrompt.context',
    inspectOn.report?.enabled === true
      && String(inspectOn.report?.boardContext ?? '').includes('E2E implementation plan'),
    JSON.stringify({ enabled: inspectOn.report?.enabled, boardContext: inspectOn.report?.boardContext }),
  )
  checks.expect(
    'phase 3 default Host composes storage-domain for the durable outbox',
    inspectOn.report?.storageDomain === true,
    JSON.stringify({
      storageDomain: inspectOn.report?.storageDomain,
      storage: inspectOn.report?.storage,
      reportOutboxAvailable: inspectOn.report?.reportOutboxAvailable,
      reportOutboxLastError: inspectOn.report?.reportOutboxLastError,
      workspaceRegistry: inspectOn.report?.workspaceRegistry,
    }),
  )
  const devleadTools = inspectOn.report?.devleadTools ?? []
  checks.expect(
    'phase 3 enabled exposes exactly the eighteen devlead tools',
    JSON.stringify(devleadTools) === JSON.stringify(DEVLEAD_TOOL_NAMES),
    JSON.stringify(devleadTools),
  )
  checks.expect(
    'phase 3 enabled exposes the remove and archive tools',
    ['devlead_remove_workspace', 'devlead_archive_session', 'devlead_unarchive_session']
      .every(name => devleadTools.includes(name)),
    JSON.stringify(devleadTools),
  )

  const policy = String(inspectOn.report?.policy ?? '')
  checks.expect(
    'phase 3 policy describes judgment-based closing',
    policy.includes('Closing Workspaces and Sessions is judgment-based'),
  )
  checks.expect(
    'phase 3 policy keeps the close safety boundary',
    policy.includes('never use closing to hide a failure'),
  )
  checks.expect(
    'phase 3 policy requires reporting every autonomous close',
    policy.includes('Report every autonomous close'),
  )
  checks.expect(
    'phase 3 policy bounds reconnaissance to feasibility triage',
    policy.includes('Feasibility triage, not research'),
  )
  checks.expect(
    'phase 3 policy hands open questions to the Session',
    policy.includes('open questions') && policy.includes('the Session owns the deeper investigation'),
  )
  checks.expect(
    'phase 3 policy keeps the Workspace registration when tidying up',
    policy.includes('keep the Workspace registration'),
  )
  checks.expect(
    'phase 3 policy carries none of the old hard-line close wording',
    !policy.includes('never clean up')
      && !policy.includes('only when the human explicitly asked, in this conversation, to close'),
  )

  // Watched-child report surface: the child is not a DevLead, so it must see
  // exactly the reporting tool (plus its own normal tools), not the lead
  // toolbox; a real report call must append the lead receipt and digest row.
  const watchedChild = await runProbeCommand(client, leadId, PROBE_WATCH_CHILD_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 watched-child probe settles success',
    watchedChild.execution?.result?.kind === 'success',
    watchedChild.text.slice(0, 500),
  )
  const watchedChildId = typeof watchedChild.report?.childId === 'string' ? watchedChild.report.childId : ''
  checks.expect(
    'phase 3 watched-child probe returns a live watched child',
    watchedChildId.length > 0
      && watchedChild.report?.watched === true
      && watchedChild.report?.live === true,
    JSON.stringify(watchedChild.report),
  )
  const childInspect = await runProbeCommand(client, watchedChildId, PROBE_INSPECT_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 watched child inspect settles success',
    childInspect.execution?.result?.kind === 'success',
    childInspect.text.slice(0, 500),
  )
  checks.expect(
    'phase 3 watched child is not DevLead-enabled and is watched by the lead',
    childInspect.report?.enabled === false && childInspect.report?.supervised === true,
    JSON.stringify({ enabled: childInspect.report?.enabled, supervised: childInspect.report?.supervised }),
  )
  checks.expect(
    'phase 3 watched child exposes exactly the report tool',
    JSON.stringify(childInspect.report?.devleadTools) === JSON.stringify(['devlead_report']),
    JSON.stringify(childInspect.report?.devleadTools),
  )
  checks.expect(
    'phase 3 watched child receives the one-way report policy',
    typeof childInspect.report?.reportPolicy === 'string'
      && childInspect.report.reportPolicy.includes('one-way')
      && childInspect.report.reportPolicy.includes('four'),
    String(childInspect.report?.reportPolicy ?? '').slice(0, 300),
  )
  const reportProbe = await runProbeCommand(client, watchedChildId, PROBE_REPORT_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 watched-child report settles success',
    reportProbe.execution?.result?.kind === 'success',
    reportProbe.text.slice(0, 500),
  )
  const reportId = typeof reportProbe.report?.report?.report?.id === 'string'
    ? reportProbe.report.report.report.id
    : ''
  const leadReports = Array.isArray(reportProbe.report?.leadReports) ? reportProbe.report.leadReports : []
  checks.expect(
    'phase 3 report names the watching lead and returns a durable receipt',
    reportProbe.report?.supervised === true
      && typeof reportProbe.report?.leadId === 'string'
      && reportId.length > 0
      && reportProbe.report?.report?.report?.kind === 'progress'
      && reportProbe.report?.report?.report?.senderSessionId === watchedChildId,
    JSON.stringify(reportProbe.report),
  )
  checks.expect(
    'phase 3 report receipt is durable before success',
    reportProbe.report?.report?.durable === true
      && reportProbe.report?.report?.queued === false
      && reportProbe.report?.report?.warning === undefined,
    JSON.stringify({
      durable: reportProbe.report?.report?.durable,
      queued: reportProbe.report?.report?.queued,
      warning: reportProbe.report?.report?.warning,
    }),
  )
  checks.expect(
    'phase 3 report appears in the lead report digest',
    leadReports.some(row => row?.id === reportId && row?.senderSessionId === watchedChildId),
    JSON.stringify(leadReports),
  )
  // Phase 1e rewrite: a progress report no longer wakes the lead via a coalesced
  // followup digest. It rides the BACKGROUND lane — a next-step inject with
  // wakeRequested:false — and an idle lead stays idle (no new turn).
  const progressBackground = reportProbe.report?.background ?? {}
  checks.expect(
    'phase 3 progress report injects on the background lane without requesting a wake',
    progressBackground.found === true
      && progressBackground.lane === 'background'
      && progressBackground.boundary === 'next-step'
      && progressBackground.wakeRequested === false
      && progressBackground.reportId === reportId
      && progressBackground.senderSessionId === watchedChildId
      && String(progressBackground.excerpt ?? '').includes('[DEV LEAD REPORT]')
      && String(progressBackground.text ?? '').includes('no action required and no wake was requested'),
    JSON.stringify({ ...progressBackground, text: undefined }),
  )
  checks.expect(
    'phase 3 progress report leaves the idle lead idle (no wake, no new turn) and is observed delivered',
    reportProbe.report?.leadStatusBefore === 'idle'
      && reportProbe.report?.leadStatusAfter === 'idle'
      && reportProbe.report?.leadTurnBefore === reportProbe.report?.leadTurnAfter
      && reportProbe.report?.deliveryState === 'delivered',
    JSON.stringify({
      before: `${String(reportProbe.report?.leadStatusBefore)}/${String(reportProbe.report?.leadTurnBefore)}`,
      after: `${String(reportProbe.report?.leadStatusAfter)}/${String(reportProbe.report?.leadTurnAfter)}`,
      deliveryState: reportProbe.report?.deliveryState,
    }),
  )

  // Watched-Session question gate: a real structured multi-question
  // ask_user_question call plus a sibling read-only call are executed through
  // the Host tools pipeline as a watched child. The DevLead pre-execute
  // listener must deny before the child's own question UI runs, forward the
  // structured question report into the lead digest, and admit an
  // action-required wake at the lead's next-step boundary — while the deny
  // stays a soft request: the sibling call still runs and no turn is forced
  // to end (case 33).
  const questionProbe = await runProbeCommand(client, leadId, PROBE_QUESTION_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 watched-child question probe settles success',
    questionProbe.execution?.result?.kind === 'success',
    questionProbe.text.slice(0, 500),
  )
  const questionResults = Array.isArray(questionProbe.report?.batch?.results) ? questionProbe.report.batch.results : []
  checks.expect(
    'phase 3 watched child ask_user_question is denied before its UI',
    questionProbe.report?.supervised === true
      && questionResults[0]?.isError === true
      && questionResults[0]?.concludesTurn === false
      && JSON.stringify(questionResults[0]?.content ?? []).includes('Direct user questions are disabled')
      && JSON.stringify(questionResults[0]?.content ?? []).includes('end your turn'),
    JSON.stringify(questionResults),
  )
  const questionReports = Array.isArray(questionProbe.report?.questionReports)
    ? questionProbe.report.questionReports
    : []
  checks.expect(
    'phase 3 watched child question is forwarded to the lead digest',
    questionReports.some(row => row?.kind === 'question'
      && typeof row?.message === 'string'
      && row.message.includes('Which e2e target?')),
    JSON.stringify(questionReports),
  )
  const forwardedQuestion = questionReports.find(row => typeof row?.message === 'string'
    && row.message.includes('Which e2e target?'))
  checks.expect(
    'phase 3 gate forwards the complete structured multi-question payload',
    forwardedQuestion !== undefined
      && stableStringify(forwardedQuestion.questions) === stableStringify(questionProbe.report?.expectedQuestions),
    JSON.stringify({ forwarded: forwardedQuestion?.questions, expected: questionProbe.report?.expectedQuestions }),
  )
  checks.expect(
    'phase 3 gate deny keeps the child running: sibling completes, no forced turn end (case 33)',
    questionResults[1]?.isError === false
      && questionProbe.report?.batch?.concluded === false
      && questionProbe.report?.childTurnEnds === 0
      && questionProbe.report?.childStatus === 'idle',
    JSON.stringify({
      sibling: questionResults[1],
      concluded: questionProbe.report?.batch?.concluded,
      childTurnEnds: questionProbe.report?.childTurnEnds,
      childStatus: questionProbe.report?.childStatus,
    }),
  )
  const gateWake = questionProbe.report?.wake ?? {}
  checks.expect(
    'phase 3 question wake admits at the lead next-step with lane action-required',
    gateWake.found === true
      && gateWake.boundary === 'next-step'
      && gateWake.lane === 'action-required'
      && gateWake.wakeRequested === true
      && gateWake.reportId === forwardedQuestion?.id
      && String(gateWake.excerpt ?? '').includes('[DEV LEAD QUESTION]'),
    JSON.stringify({ ...gateWake, text: undefined }),
  )
  // Deep-compare the FULL wake payload: every question line, every option
  // label/description, and both multi-select flags, plus the answer routing.
  const expectedWakeLines = []
  for (const question of questionProbe.report?.expectedQuestions ?? []) {
    expectedWakeLines.push(`- question: [${question.id}] ${question.header}: ${question.question}`)
    for (const option of question.options ?? []) {
      expectedWakeLines.push(`  - ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
    }
    expectedWakeLines.push(`  (multi-select: ${question.multi_select === true ? 'yes' : 'no'})`)
  }
  const gateWakeText = String(gateWake.text ?? '')
  checks.expect(
    'phase 3 gate wake payload deep-compares every question, option, description, and multi-select flag',
    gateWake.found === true
      && expectedWakeLines.length >= 8
      && expectedWakeLines.every(line => gateWakeText.includes(line))
      && gateWakeText.includes(`- question report: ${forwardedQuestion?.id}`)
      && gateWakeText.includes(`  session: "${questionProbe.report?.childId}"`),
    JSON.stringify({ missing: expectedWakeLines.filter(line => !gateWakeText.includes(line)), text: gateWakeText.slice(0, 1200) }),
  )

  // devlead_report question path (Phase 1c): from inside the watched child, a
  // durable question requests the turn end through the executor marker while
  // the batch completes and committed next-step work survives; a
  // write-protected outbox window produces the memory-only receipt with no
  // turn end and a restatement warning; the outbox then recovers durably.
  const questionReportProbe = await runProbeCommand(
    client, watchedChildId, PROBE_QUESTION_REPORT_COMMAND, DISPATCH_PROBE_TIMEOUT_MS,
  )
  checks.expect(
    'phase 3 question-report probe settles success inside the watched child',
    questionReportProbe.execution?.result?.kind === 'success'
      && questionReportProbe.report?.supervised === true
      && questionReportProbe.report?.leadId === leadId,
    questionReportProbe.text.slice(0, 500),
  )
  const durableQuestionResults = Array.isArray(questionReportProbe.report?.durable?.batch?.results)
    ? questionReportProbe.report.durable.batch.results
    : []
  const durableQuestionValue = durableQuestionResults[0]?.value ?? {}
  checks.expect(
    'phase 3 durable question sets turnEndRequested and the executor concludesTurn marker',
    durableQuestionResults[0]?.isError === false
      && durableQuestionResults[0]?.concludesTurn === true
      && durableQuestionValue.durable === true
      && durableQuestionValue.turnEndRequested === true
      && durableQuestionValue.questionId === durableQuestionValue.report?.id
      && durableQuestionValue.report?.kind === 'question',
    JSON.stringify(durableQuestionResults[0]),
  )
  checks.expect(
    'phase 3 question turn-end request completes the batch and keeps committed next-step work',
    durableQuestionResults[1]?.isError === false
      && questionReportProbe.report?.durable?.batch?.concluded === true
      && questionReportProbe.report?.markerPending === true,
    JSON.stringify({
      sibling: durableQuestionResults[1]?.callId,
      concluded: questionReportProbe.report?.durable?.batch?.concluded,
      markerPending: questionReportProbe.report?.markerPending,
    }),
  )
  checks.expect(
    'phase 3 question result states the request semantics, not an immediate close',
    String(durableQuestionValue.guidance ?? '').includes('not an immediate close')
      && String(durableQuestionValue.guidance ?? '').includes('the turn ends after the current tool batch and any committed next-step work')
      && String(durableQuestionValue.guidance ?? '').includes('do not poll or resend'),
    JSON.stringify(durableQuestionValue.guidance),
  )
  const durableQuestionReports = Array.isArray(questionReportProbe.report?.durable?.reports)
    ? questionReportProbe.report.durable.reports
    : []
  checks.expect(
    'phase 3 text question lands in the lead digest without a structured payload',
    durableQuestionReports.some(row => row?.kind === 'question'
      && typeof row?.message === 'string'
      && row.message.includes('which release train')
      && row.questions === undefined),
    JSON.stringify(durableQuestionReports),
  )
  const reportWake = questionReportProbe.report?.durable?.wake ?? {}
  checks.expect(
    'phase 3 report question wake admits at the lead next-step with lane action-required',
    reportWake.found === true
      && reportWake.boundary === 'next-step'
      && reportWake.lane === 'action-required'
      && reportWake.wakeRequested === true
      && String(reportWake.excerpt ?? '').includes('[DEV LEAD QUESTION]'),
    JSON.stringify({ ...reportWake, text: undefined }),
  )
  const reportWakeText = String(reportWake.text ?? '')
  const textQuestionRow = durableQuestionReports.find(row => typeof row?.message === 'string'
    && row.message.includes('which release train'))
  checks.expect(
    'phase 3 report question wake carries the full text question and answer routing',
    reportWake.found === true
      && textQuestionRow !== undefined
      && String(textQuestionRow.message).split('\n').every(line => reportWakeText.includes(`  ${line}`))
      && reportWakeText.includes(`- question report: ${textQuestionRow.id}`)
      && reportWakeText.includes(`  session: "${watchedChildId}"`),
    JSON.stringify({ text: reportWakeText.slice(0, 1200), row: textQuestionRow?.id }),
  )
  const memoryOnly = questionReportProbe.report?.memoryOnly ?? {}
  const memoryOnlyResults = Array.isArray(memoryOnly.batch?.results) ? memoryOnly.batch.results : []
  const memoryOnlyValue = memoryOnlyResults[0]?.value ?? {}
  checks.expect(
    'phase 3 memory-only question requests no turn end and asks for a restatement',
    memoryOnly.available === true
      && memoryOnlyResults[0]?.isError === false
      && memoryOnlyResults[0]?.concludesTurn === false
      && memoryOnly.batch?.concluded === false
      && memoryOnlyValue.durable === false
      && memoryOnlyValue.turnEndRequested === undefined
      && String(memoryOnlyValue.warning ?? '').includes('restate the question in your final assistant message'),
    JSON.stringify(memoryOnly),
  )
  const recoveryResults = Array.isArray(questionReportProbe.report?.recovery?.results)
    ? questionReportProbe.report.recovery.results
    : []
  // This check only proves writability (and therefore durable delivery)
  // returned after the mode restore; it is a fresh report, not an automatic
  // replay of the memory-only one (Phase 1c implements no replay).
  checks.expect(
    'phase 3 outbox writability restores durable question delivery (fresh report, no replay claim)',
    recoveryResults[0]?.isError === false
      && recoveryResults[0]?.value?.durable === true
      && recoveryResults[0]?.value?.turnEndRequested === true
      && recoveryResults[0]?.concludesTurn === true,
    JSON.stringify(recoveryResults[0]),
  )

  // Real prompted child turn (scripted llm/stream, real agent-loop events):
  // the durable question concludes its batch, but the committed next-step
  // marker steered during the batch must still run in a later real step
  // before the single turn/end. markerPending alone would only prove queue
  // state; these checks read the durable log and the model requests.
  const questionTurnProbe = await runProbeCommand(client, leadId, PROBE_QUESTION_TURN_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 scripted question-turn probe settles success with a real child log',
    questionTurnProbe.execution?.result?.kind === 'success'
      && typeof questionTurnProbe.report?.childId === 'string'
      && (questionTurnProbe.report?.eventCount ?? 0) > 0,
    questionTurnProbe.text.slice(0, 500),
  )
  const turnFacts = questionTurnProbe.report ?? {}
  checks.expect(
    'phase 3 scripted child turn has real turns/steps and one natural completed turn/end',
    (turnFacts.turns ?? 0) >= 1
      && (turnFacts.steps ?? 0) >= 2
      && turnFacts.turnEnds === 1
      && turnFacts.turnEndReason === 'completed',
    JSON.stringify({
      turns: turnFacts.turns, steps: turnFacts.steps, turnEnds: turnFacts.turnEnds,
      turnEndReason: turnFacts.turnEndReason, eventCount: turnFacts.eventCount,
    }),
  )
  const scriptedQuestionResult = (turnFacts.toolResults ?? []).find(entry => entry?.name === 'devlead_report')
  checks.expect(
    'phase 3 scripted durable question carries turnEndRequested and the concludesTurn marker',
    scriptedQuestionResult?.isError === false
      && scriptedQuestionResult?.concludesTurn === true
      && scriptedQuestionResult?.value?.durable === true
      && scriptedQuestionResult?.value?.turnEndRequested === true
      && scriptedQuestionResult?.value?.questionId === scriptedQuestionResult?.value?.report?.id,
    JSON.stringify(scriptedQuestionResult),
  )
  checks.expect(
    'phase 3 committed next-step marker runs in a later real step after the concluding batch, before turn/end',
    (turnFacts.questionResultIndex ?? -1) >= 0
      && (turnFacts.markerMessageIndex ?? -1) > turnFacts.questionResultIndex
      && Array.isArray(turnFacts.stepStarts) && turnFacts.stepStarts.length >= 2
      // The marker is admitted inside the second step: its user/message lands
      // after that step/start and before the single turn/end.
      && turnFacts.stepStarts[1] < turnFacts.markerMessageIndex
      && turnFacts.turnEndIndex > turnFacts.markerMessageIndex
      && turnFacts.markerPendingAfter === false,
    JSON.stringify({
      questionResultIndex: turnFacts.questionResultIndex,
      markerMessageIndex: turnFacts.markerMessageIndex,
      stepStarts: turnFacts.stepStarts,
      turnEndIndex: turnFacts.turnEndIndex,
      markerPendingAfter: turnFacts.markerPendingAfter,
    }),
  )
  const turnRequests = Array.isArray(turnFacts.requests) ? turnFacts.requests : []
  checks.expect(
    'phase 3 second model request really saw the marker (two intercepted requests, batch then marker step)',
    turnRequests.length === 2
      // The second request's history carries the first step's tool calls, and
      // its user inputs carry the committed marker text.
      && (turnRequests[1]?.toolNames ?? []).includes('devlead_report')
      && (turnRequests[1]?.toolNames ?? []).includes('glob')
      && typeof turnFacts.markerText === 'string'
      && (turnRequests[1]?.userTexts ?? []).some(text => text.includes(turnFacts.markerText)),
    JSON.stringify(turnRequests),
  )
  const turnQuestionReports = Array.isArray(turnFacts.questionReports) ? turnFacts.questionReports : []
  const turnWake = turnFacts.wake ?? {}
  checks.expect(
    'phase 3 scripted question reaches the lead digest and action-required wake',
    turnQuestionReports.some(row => row?.kind === 'question'
      && typeof row?.message === 'string'
      && row.message.includes('which channel'))
      && turnWake.found === true
      && turnWake.boundary === 'next-step'
      && turnWake.lane === 'action-required',
    JSON.stringify({ reports: turnQuestionReports, wake: { ...turnWake, text: undefined } }),
  )

  // Case 33 with a REAL prompted child: the scripted model's ask_user_question
  // is gate-denied, then the model keeps working (another tool-call step and a
  // final text step). The deny must not force the turn to end.
  const questionContinueProbe = await runProbeCommand(client, leadId, PROBE_QUESTION_CONTINUE_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 scripted gate-continue probe settles success with a real child log',
    questionContinueProbe.execution?.result?.kind === 'success'
      && typeof questionContinueProbe.report?.childId === 'string'
      && (questionContinueProbe.report?.eventCount ?? 0) > 0,
    questionContinueProbe.text.slice(0, 500),
  )
  const continueFacts = questionContinueProbe.report ?? {}
  const continueRequests = Array.isArray(continueFacts.requests) ? continueFacts.requests : []
  checks.expect(
    'phase 3 denied model really continues: three requests, later steps, one natural completed turn/end (case 33)',
    continueRequests.length === 3
      && (continueFacts.steps ?? 0) >= 3
      && continueFacts.turnEnds === 1
      && continueFacts.turnEndReason === 'completed',
    JSON.stringify({
      requests: continueRequests.length, steps: continueFacts.steps,
      turnEnds: continueFacts.turnEnds, turnEndReason: continueFacts.turnEndReason,
    }),
  )
  const deniedAskResult = (continueFacts.toolResults ?? []).find(entry => entry?.name === 'ask_user_question')
  checks.expect(
    'phase 3 scripted ask_user_question is denied without a concludesTurn marker',
    deniedAskResult?.isError === true
      && deniedAskResult?.concludesTurn === false
      && JSON.stringify(deniedAskResult?.content ?? []).includes('Direct user questions are disabled'),
    JSON.stringify(deniedAskResult),
  )
  const continuedGlobResult = (continueFacts.toolResults ?? []).find(entry => entry?.name === 'glob')
  checks.expect(
    'phase 3 later tool call runs after the deny and before the natural turn/end',
    continuedGlobResult?.isError === false
      && (continueFacts.askResultIndex ?? -1) >= 0
      && (continueFacts.globCallIndex ?? -1) > continueFacts.askResultIndex
      && (continueFacts.globResultIndex ?? -1) > continueFacts.askResultIndex
      && continueFacts.turnEndIndex > continueFacts.globResultIndex,
    JSON.stringify({
      askResultIndex: continueFacts.askResultIndex,
      globCallIndex: continueFacts.globCallIndex,
      globResultIndex: continueFacts.globResultIndex,
      turnEndIndex: continueFacts.turnEndIndex,
    }),
  )
  const continueReports = Array.isArray(continueFacts.questionReports) ? continueFacts.questionReports : []
  const continueWake = continueFacts.wake ?? {}
  checks.expect(
    'phase 3 continued child question reaches the lead digest and action-required wake',
    continueReports.some(row => row?.kind === 'question'
      && typeof row?.message === 'string'
      && row.message.includes('Which e2e continue target?'))
      && continueWake.found === true
      && continueWake.boundary === 'next-step'
      && continueWake.lane === 'action-required',
    JSON.stringify({ reports: continueReports, wake: { ...continueWake, text: undefined } }),
  )

  // Queued inbox inputs: the probe appends a human and an own-relay input to a
  // live idle child through the real durable inbox, reads them back, and
  // exercises the ownership refusal and idempotent retraction.
  const inboxProbe = await runProbeCommand(client, leadId, PROBE_INBOX_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 inbox probe settles success with an empty live queue',
    inboxProbe.execution?.result?.kind === 'success'
      && Array.isArray(inboxProbe.report?.empty) && inboxProbe.report.empty.length === 0,
    inboxProbe.text.slice(0, 500),
  )
  const inboxHumanRow = Array.isArray(inboxProbe.report?.withHuman) ? inboxProbe.report.withHuman[0] : undefined
  checks.expect(
    'phase 3 queuedInputs reports the human input with source, excerpt, and enqueue time',
    inboxHumanRow?.sourceKind === 'user'
      && inboxHumanRow?.boundary === 'next-turn'
      && inboxHumanRow?.excerpt === 'human queued instruction'
      && typeof inboxHumanRow?.enqueuedAt === 'number',
    JSON.stringify(inboxProbe.report?.withHuman),
  )
  checks.expect(
    'phase 3 retract refuses a human-authored queued input',
    inboxProbe.report?.humanRefusal?.refused === true
      && inboxProbe.report?.humanRefusal?.code === 'DEVLEAD_INVALID_INPUT',
    JSON.stringify(inboxProbe.report?.humanRefusal),
  )
  const inboxAfter = Array.isArray(inboxProbe.report?.after) ? inboxProbe.report.after : []
  checks.expect(
    'phase 3 retract withdraws the own relay idempotently and keeps the human input',
    inboxProbe.report?.first?.retracted === true
      && inboxProbe.report?.second?.retracted === false
      && inboxAfter.length === 1
      && inboxAfter[0]?.id === inboxHumanRow?.id,
    JSON.stringify({ first: inboxProbe.report?.first, second: inboxProbe.report?.second, after: inboxAfter }),
  )

  // Phase 1d answer routing with a REAL prompted child: the lead answers a
  // running child's forwarded question via steer during the glob dispatch; the
  // answer must be presented in a later real step before the single turn/end,
  // the same-key/same-text retry must return the original receipt, and a
  // different answer must conflict. Facts come from the durable log, the
  // intercepted model requests, the lead's durable answer record, and the
  // derived question/answer view.
  const answerTurnProbe = await runProbeCommand(client, leadId, PROBE_ANSWER_TURN_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 1d scripted answer-turn probe settles success with a real child log',
    answerTurnProbe.execution?.result?.kind === 'success'
      && typeof answerTurnProbe.report?.childId === 'string'
      && (answerTurnProbe.report?.eventCount ?? 0) > 0,
    answerTurnProbe.text.slice(0, 500),
  )
  const answerFacts = answerTurnProbe.report?.answerFacts ?? {}
  const answerDelivery = answerFacts.answerReceipt?.delivery ?? {}
  checks.expect(
    'phase 1d answer steers the running child next-step with a wake and echoes question_id',
    answerDelivery.primitive === 'steer'
      && answerDelivery.boundary === 'next-step'
      && answerDelivery.wakeRequested === true
      && typeof answerDelivery.messageId === 'string'
      && answerDelivery.questionId === answerFacts.questionId
      && answerFacts.childStatusAtAnswer === 'running',
    JSON.stringify({ answerDelivery, questionId: answerFacts.questionId, childStatusAtAnswer: answerFacts.childStatusAtAnswer }),
  )
  checks.expect(
    'phase 1d same-key/same-text answer retry returns the original receipt; a different answer conflicts',
    answerFacts.retryReceipt?.delivery?.messageId === answerDelivery.messageId
      && answerFacts.conflictCode === 'DEVLEAD_QUESTION_ALREADY_ANSWERED',
    JSON.stringify({ retry: answerFacts.retryReceipt?.delivery, conflictCode: answerFacts.conflictCode }),
  )
  const answerTurnFacts = answerTurnProbe.report ?? {}
  checks.expect(
    'phase 1d answer is presented in a later real step after the question batch, before the single completed turn/end',
    (answerTurnFacts.questionResultIndex ?? -1) >= 0
      && (answerTurnFacts.answerMessageIndex ?? -1) > answerTurnFacts.questionResultIndex
      && Array.isArray(answerTurnFacts.stepStarts) && answerTurnFacts.stepStarts.length >= 2
      && answerTurnFacts.stepStarts[1] < answerTurnFacts.answerMessageIndex
      && answerTurnFacts.turnEndIndex > answerTurnFacts.answerMessageIndex
      && answerTurnFacts.answerPendingAfter === false
      && (answerTurnFacts.turns ?? 0) >= 1
      && answerTurnFacts.turnEnds === 1
      && answerTurnFacts.turnEndReason === 'completed',
    JSON.stringify({
      questionResultIndex: answerTurnFacts.questionResultIndex,
      answerMessageIndex: answerTurnFacts.answerMessageIndex,
      stepStarts: answerTurnFacts.stepStarts,
      turnEndIndex: answerTurnFacts.turnEndIndex,
      answerPendingAfter: answerTurnFacts.answerPendingAfter,
      turnEndReason: answerTurnFacts.turnEndReason,
    }),
  )
  const answerRequests = Array.isArray(answerTurnFacts.requests) ? answerTurnFacts.requests : []
  checks.expect(
    'phase 1d second model request really saw the answer text',
    answerRequests.length === 2
      && typeof answerTurnFacts.answerText === 'string'
      && (answerRequests[1]?.userTexts ?? []).some(text => text.includes(answerTurnFacts.answerText)),
    JSON.stringify(answerRequests),
  )
  const answerRecords = Array.isArray(answerTurnFacts.answerRecords) ? answerTurnFacts.answerRecords : []
  const answerView = answerTurnFacts.questionAnswerView ?? {}
  checks.expect(
    'phase 1d durable answer record is admitted and the derived view reports answered/presented',
    answerRecords.some(record => record?.status === 'admitted' && record?.messageId === answerDelivery.messageId)
      && answerView.questionStatus === 'answered'
      && answerView.answerStatus === 'presented'
      && answerView.answerMessageId === answerDelivery.messageId,
    JSON.stringify({ answerRecords, answerView }),
  )
  const answerWake = answerTurnFacts.wake ?? {}
  const answerQuestionReports = Array.isArray(answerTurnFacts.questionReports) ? answerTurnFacts.questionReports : []
  checks.expect(
    'phase 1d answered question reached the lead digest and action-required wake',
    answerQuestionReports.some(row => row?.kind === 'question' && row?.id === answerFacts.questionId)
      && answerWake.found === true
      && answerWake.boundary === 'next-step'
      && answerWake.lane === 'action-required',
    JSON.stringify({ reports: answerQuestionReports, wake: { ...answerWake, text: undefined } }),
  )

  // Phase 1d answer inbox lifecycle: idle-child delivery metadata + retract
  // refusal + background, and running-child clear-own/clear-all through the
  // real workspace/session-stop fan-out.
  const answerInboxProbe = await runProbeCommand(client, leadId, PROBE_ANSWER_INBOX_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 1d answer-inbox probe settles success with metadata/clear-own/clear-all facts',
    answerInboxProbe.execution?.result?.kind === 'success'
      && answerInboxProbe.report?.metadata !== null && typeof answerInboxProbe.report?.metadata === 'object'
      && answerInboxProbe.report?.clearOwn !== null && typeof answerInboxProbe.report?.clearOwn === 'object'
      && answerInboxProbe.report?.clearAll !== null && typeof answerInboxProbe.report?.clearAll === 'object',
    answerInboxProbe.text.slice(0, 500),
  )
  const metaFacts = answerInboxProbe.report?.metadata ?? {}
  checks.expect(
    'phase 1d answer steers a running child next-step and the derived view reports answered/admitted',
    metaFacts.answerDelivery?.primitive === 'steer'
      && metaFacts.answerDelivery?.boundary === 'next-step'
      && metaFacts.viewAfterAnswer?.questionStatus === 'answered'
      && metaFacts.viewAfterAnswer?.answerStatus === 'admitted',
    JSON.stringify({ answerDelivery: metaFacts.answerDelivery, viewAfterAnswer: metaFacts.viewAfterAnswer }),
  )
  const metaQueued = Array.isArray(metaFacts.queued) ? metaFacts.queued : []
  const metaAnswerRow = metaQueued.find(row => row?.id === metaFacts.answerDelivery?.messageId)
  checks.expect(
    'phase 1d queuedInputs carries the answer intent/questionId/wakeRequested/deliveryState',
    metaAnswerRow?.intent === 'answer'
      && metaAnswerRow?.questionId === metaFacts.questionId
      && metaAnswerRow?.wakeRequested === true
      && metaAnswerRow?.deliveryState === 'admitted'
      && metaAnswerRow?.boundary === 'next-step',
    JSON.stringify(metaAnswerRow),
  )
  checks.expect(
    'phase 1d retract refuses the answer but accepts background and instruction; the answer stays pending',
    metaFacts.answerRetract?.refused === true
      && metaFacts.answerRetract?.code === 'DEVLEAD_INVALID_INPUT'
      && metaFacts.backgroundRetract?.retracted === true
      && metaFacts.instructionRetract?.retracted === true
      && metaFacts.answerStillPending === true,
    JSON.stringify({
      answerRetract: metaFacts.answerRetract,
      backgroundRetract: metaFacts.backgroundRetract,
      instructionRetract: metaFacts.instructionRetract,
      answerStillPending: metaFacts.answerStillPending,
    }),
  )
  checks.expect(
    'phase 1d background injects next-step without requesting a wake',
    metaFacts.backgroundDelivery?.primitive === 'inject'
      && metaFacts.backgroundDelivery?.boundary === 'next-step'
      && metaFacts.backgroundDelivery?.wakeRequested === false,
    JSON.stringify(metaFacts.backgroundDelivery),
  )
  const clearOwnFacts = answerInboxProbe.report?.clearOwn ?? {}
  checks.expect(
    'phase 1d clear-own keeps the pending answer and human input, drops the own instruction, question stays answered',
    clearOwnFacts.answerPending === true
      && clearOwnFacts.humanPending === true
      && clearOwnFacts.ownInstructionPending === false
      && clearOwnFacts.viewAfter?.questionStatus === 'answered'
      && clearOwnFacts.replacement?.interrupted === true
      && clearOwnFacts.replacement?.retainedInputs === 2,
    JSON.stringify({
      answerPending: clearOwnFacts.answerPending,
      humanPending: clearOwnFacts.humanPending,
      ownInstructionPending: clearOwnFacts.ownInstructionPending,
      viewAfter: clearOwnFacts.viewAfter,
      replacement: clearOwnFacts.replacement,
    }),
  )
  const clearAllFacts = answerInboxProbe.report?.clearAll ?? {}
  const clearAllRecords = Array.isArray(clearAllFacts.answerRecords) ? clearAllFacts.answerRecords : []
  checks.expect(
    'phase 1d clear-all discards the pending answer, reopens the question, and records the discard durably',
    clearAllFacts.answerPending === false
      && clearAllFacts.viewAfter?.questionStatus === 'open'
      && clearAllFacts.viewAfter?.answerStatus === 'discarded'
      && clearAllRecords.some(record => record?.status === 'discarded' && record?.messageId === clearAllFacts.answerMessageId),
    JSON.stringify({ answerPending: clearAllFacts.answerPending, viewAfter: clearAllFacts.viewAfter, answerRecords: clearAllRecords }),
  )

  // Creation-time dispatch settings: the probe creates real Sessions with a
  // model from the Host catalog and with Agent Teams, then reads the durable
  // child state back. The profile default must stay untouched.
  const dispatch = await runProbeCommand(client, leadId, PROBE_DISPATCH_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 dispatch probe settles success',
    dispatch.execution?.result?.kind === 'success',
    dispatch.text.slice(0, 500),
  )
  checks.expect(
    'phase 3 dispatch probe returns its JSON contract',
    dispatch.report !== null && typeof dispatch.report === 'object'
      && typeof dispatch.report.model === 'object' && dispatch.report.model !== null
      && typeof dispatch.report.teams === 'object' && dispatch.report.teams !== null
      && typeof dispatch.report.modelUnavailable === 'object' && dispatch.report.modelUnavailable !== null,
  )
  const dispatchListModels = dispatch.report?.listModels ?? {}
  const listModelsView = dispatchListModels.view ?? null
  checks.expect(
    'phase 3 devlead_list_models returns a catalog view',
    dispatchListModels.error === null && listModelsView !== null && typeof listModelsView === 'object',
    JSON.stringify(dispatchListModels.error ?? listModelsView?.default),
  )
  checks.expect(
    'phase 3 list_models reports the Host default selection',
    typeof listModelsView?.default?.provider === 'string'
      && typeof listModelsView?.default?.model === 'string',
    JSON.stringify(listModelsView?.default),
  )
  checks.expect(
    'phase 3 list_models exposes provider and failure arrays',
    Array.isArray(listModelsView?.providers)
      && Array.isArray(listModelsView?.failures)
      && Array.isArray(listModelsView?.routableProviders),
    JSON.stringify({
      providers: listModelsView?.providers?.length,
      failures: listModelsView?.failures?.length,
    }),
  )
  const presets = dispatch.report?.presets ?? {}
  const presetRows = Array.isArray(presets.view?.presets) ? presets.view.presets : []
  checks.expect(
    'phase 3 agent preset roster is available and lists at least one row',
    presets.error === null
      && presets.view?.available === true
      && presetRows.length > 0
      && presetRows.every(row => typeof row.id === 'string' && row.id.length > 0)
      && presetRows.filter(row => row.default === true).length === 1,
    JSON.stringify({
      error: presets.error,
      available: presets.view?.available,
      presets: presetRows.map(row => ({ id: row.id, default: row.default, broken: row.broken })),
    }),
  )
  const dispatchModel = dispatch.report?.model ?? {}
  const dispatchTeams = dispatch.report?.teams ?? {}
  const dispatchUnavailable = dispatch.report?.modelUnavailable ?? {}
  checks.expect(
    'phase 3 dispatch probe resolves a catalog model or reports why not',
    dispatchModel.available === true
      || (typeof dispatchModel.reason === 'string' && dispatchModel.reason.length > 0),
    dispatchModel.reason ?? `${String(dispatchModel.provider)}/${String(dispatchModel.model)}`,
  )
  if (dispatchModel.available === true) {
    const expected = { provider: dispatchModel.provider, model: dispatchModel.model }
    checks.expect(
      'phase 3 model selection appears in the create result',
      JSON.stringify(dispatchModel.child?.result) === JSON.stringify(expected),
      JSON.stringify({ expected, actual: dispatchModel.child?.result }),
    )
    checks.expect(
      'phase 3 model selection is recorded on the child Agent',
      JSON.stringify(dispatchModel.child?.current) === JSON.stringify(expected),
      JSON.stringify(dispatchModel.child?.current),
    )
    checks.expect(
      'phase 3 the model selection is durable in the child log',
      dispatchModel.child?.modelEvents >= 1,
      String(dispatchModel.child?.modelEvents),
    )
  } else {
    const reason = String(dispatchModel.reason ?? 'no model catalog')
    checks.skip('phase 3 model selection appears in the create result', reason)
    checks.skip('phase 3 model selection is recorded on the child Agent', reason)
    checks.skip('phase 3 the model selection is durable in the child log', reason)
  }
  checks.expect(
    'phase 3 dispatch never rewrites the profile default model',
    JSON.stringify(dispatch.report?.defaultModelBefore) === JSON.stringify(dispatch.report?.defaultModelAfter),
    JSON.stringify({ before: dispatch.report?.defaultModelBefore, after: dispatch.report?.defaultModelAfter }),
  )
  const teamsExpected = agentTeamsSupportedByVersion(dshVersion)
  if (dispatchTeams.available === true) {
    checks.expect(
      'phase 3 agent_teams true enables Team mode on the child',
      teamsExpected && dispatchTeams.child?.result === true && dispatchTeams.child?.enabled === true,
      `DSH ${dshVersion}; ${JSON.stringify({ result: dispatchTeams.child?.result, enabled: dispatchTeams.child?.enabled })}`,
    )
    checks.expect(
      'phase 3 team/mode is durable in the child log',
      Array.isArray(dispatchTeams.child?.teamEvents)
        && dispatchTeams.child.teamEvents.some(event => event?.enabled === true),
      JSON.stringify(dispatchTeams.child?.teamEvents),
    )
    checks.expect(
      'phase 3 agent_teams false explicitly disables Team mode',
      dispatchTeams.off?.result === false && dispatchTeams.off?.enabled === false,
      JSON.stringify(dispatchTeams.off),
    )
  } else {
    const unavailable = dispatchTeams.unavailable ?? {}
    checks.expect(
      'phase 3 agent_teams true is rejected on a Team-less Host (expected before DSH 0.2.2-rc.2)',
      unavailable.code === 'DEVLEAD_TEAM_UNAVAILABLE' && teamsExpected === false,
      `DSH ${dshVersion}; ${String(unavailable.code)}: ${String(unavailable.message).slice(0, 200)}`,
    )
    checks.expect(
      'phase 3 the Team-unavailable error names the DSH 0.2.2-rc.2 requirement',
      String(unavailable.message).includes('0.2.2-rc.2')
        && String(unavailable.message).includes('default composition'),
      String(unavailable.message).slice(0, 260),
    )
    checks.expect(
      'phase 3 a rejected agent_teams request creates no Session and explicit false still works',
      unavailable.sessionsAfter === unavailable.sessionsBefore && dispatchTeams.off?.result === false,
      JSON.stringify({
        sessions: `${String(unavailable.sessionsBefore)} -> ${String(unavailable.sessionsAfter)}`,
        off: dispatchTeams.off,
      }),
    )
  }
  checks.expect(
    'phase 3 omitting the settings leaves both result fields absent',
    dispatch.report?.omitted?.modelPresent === false
      && dispatch.report?.omitted?.agentTeamsPresent === false,
    JSON.stringify(dispatch.report?.omitted),
  )
  checks.expect(
    'phase 3 an unavailable model fails with DEVLEAD_MODEL_UNAVAILABLE',
    dispatchUnavailable.code === 'DEVLEAD_MODEL_UNAVAILABLE',
    `${String(dispatchUnavailable.code)}: ${String(dispatchUnavailable.message).slice(0, 200)}`,
  )
  checks.expect(
    'phase 3 the unavailable-model failure names the route',
    String(dispatchUnavailable.message).includes('definitely-not-a-model'),
    String(dispatchUnavailable.message).slice(0, 240),
  )
  checks.expect(
    'phase 3 the unavailable-model failure creates no Session',
    dispatchUnavailable.sessionsAfter === dispatchUnavailable.sessionsBefore,
    `${String(dispatchUnavailable.sessionsBefore)} -> ${String(dispatchUnavailable.sessionsAfter)}`,
  )

  // The close probe owns every durable action; the harness only reads facts.
  const close = await runProbeCommand(client, leadId, PROBE_CLOSE_COMMAND, CLOSE_PROBE_TIMEOUT_MS)
  checks.expect(
    'phase 3 close probe settles success',
    close.execution?.result?.kind === 'success',
    close.text.slice(0, 500),
  )
  checks.expect(
    'phase 3 close probe returns its JSON contract',
    close.report !== null && typeof close.report === 'object'
      && typeof close.report.archive === 'object' && close.report.archive !== null
      && typeof close.report.active === 'object' && close.report.active !== null
      && typeof close.report.remove === 'object' && close.report.remove !== null
      && typeof close.report.selfArchive === 'object' && close.report.selfArchive !== null,
  )
  const report = close.report ?? {}
  const archive = report.archive ?? {}
  const active = report.active ?? {}
  const removed = report.remove ?? {}
  const archivedChild = String(archive.childId ?? '')
  const activeChild = String(active.childId ?? '')

  checks.expect(
    'phase 3 first archive reports archived and no stop',
    archive.first?.archived === true && archive.first?.stopped === false,
    JSON.stringify(archive.first),
  )
  checks.expect(
    'phase 3 registry archive set carries the archived Session',
    Array.isArray(archive.archivedSetAfterFirst) && archive.archivedSetAfterFirst.includes(archivedChild),
    JSON.stringify(archive.archivedSetAfterFirst),
  )
  checks.expect('phase 3 the archived Session view reports archived', archive.viewArchivedAfterFirst === true)
  checks.expect('phase 3 the archived Session listing row reports archived', archive.rowArchivedAfterFirst === true)
  checks.expect(
    'phase 3 the prompted child log is durable and non-empty before archiving',
    archive.logBefore?.readable === true && archive.logBefore?.events > 0,
    JSON.stringify(archive.logBefore),
  )
  checks.expect(
    'phase 3 a repeated archive is an idempotent no-op without a stop',
    archive.second?.archived === true && archive.second?.stopped === false,
    JSON.stringify(archive.second),
  )
  checks.expect(
    'phase 3 a repeated archive does not duplicate the archive entry',
    Array.isArray(archive.archivedSetAfterSecond)
      && archive.archivedSetAfterSecond.filter(id => id === archivedChild).length === 1,
    JSON.stringify(archive.archivedSetAfterSecond),
  )
  checks.expect('phase 3 unarchive reports unarchived', archive.unarchive?.archived === false, JSON.stringify(archive.unarchive))
  checks.expect(
    'phase 3 unarchive clears the registry archive entry',
    Array.isArray(archive.archivedSetAfterUnarchive) && !archive.archivedSetAfterUnarchive.includes(archivedChild),
    JSON.stringify(archive.archivedSetAfterUnarchive),
  )
  checks.expect('phase 3 the restored Session view reports unarchived', archive.viewArchivedAfterUnarchive === false)
  checks.expect(
    'phase 3 the Session log survives archive and unarchive',
    archive.logAfterUnarchive?.readable === true
      && archive.logAfterUnarchive?.events === archive.logBefore?.events,
    JSON.stringify({ before: archive.logBefore, after: archive.logAfterUnarchive }),
  )

  checks.expect(
    'phase 3 active work refuses the archive with DEVLEAD_SESSION_ACTIVE',
    active.refusedCode === 'DEVLEAD_SESSION_ACTIVE',
    `${String(active.refusedCode)}: ${String(active.refusedMessage).slice(0, 200)}`,
  )
  checks.expect(
    'phase 3 the active refusal names the running work and the escape hatch',
    String(active.refusedMessage).includes('turn') && String(active.refusedMessage).includes('stop_running'),
    String(active.refusedMessage).slice(0, 240),
  )
  checks.expect(
    'phase 3 the active refusal wrote no archive entry',
    Array.isArray(active.archivedSetAfterRefusal) && !active.archivedSetAfterRefusal.includes(activeChild),
    JSON.stringify(active.archivedSetAfterRefusal),
  )
  checks.expect(
    'phase 3 stop_running archives and reports the requested stop',
    active.stopResult?.archived === true && active.stopResult?.stopped === true,
    active.stopError ?? JSON.stringify(active.stopResult),
  )
  checks.expect(
    'phase 3 stop_running reaches the Host session-stop provider',
    active.stopRequests >= 1,
    String(active.stopRequests),
  )
  checks.expect(
    'phase 3 the stopped Session is durably archived',
    Array.isArray(active.archivedSetAfterStop) && active.archivedSetAfterStop.includes(activeChild),
    JSON.stringify(active.archivedSetAfterStop),
  )
  checks.expect(
    'phase 3 the lead Session cannot archive itself',
    report.selfArchive?.code === 'DEVLEAD_INVALID_INPUT',
    `${String(report.selfArchive?.code)}: ${String(report.selfArchive?.message).slice(0, 200)}`,
  )

  checks.expect('phase 3 remove reports the registration removed', removed.removed === true)
  checks.expect(
    'phase 3 the removal snapshot carries the ungrouped Session ids',
    Array.isArray(removed.snapshotSessionIds) && removed.snapshotSessionIds.includes(archivedChild),
    JSON.stringify(removed.snapshotSessionIds),
  )
  checks.expect(
    'phase 3 the Workspace listing no longer carries the removed registration',
    Array.isArray(removed.workspaceIdsAfter)
      && !removed.workspaceIdsAfter.includes(report.workspace?.workspaceId),
    JSON.stringify(removed.workspaceIdsAfter),
  )
  checks.expect(
    'phase 3 removal leaves the directory and its marker file in place',
    removed.directoryExists === true && removed.markerContent === 'devlead e2e close marker\n',
    JSON.stringify({ directoryExists: removed.directoryExists, marker: removed.markerContent }),
  )
  checks.expect(
    'phase 3 removal leaves the Session log readable and unchanged',
    removed.logBefore?.readable === true && removed.logAfter?.readable === true
      && removed.logBefore?.events === removed.logAfter?.events
      && removed.logAfter?.events > 0,
    JSON.stringify({ before: removed.logBefore, after: removed.logAfter }),
  )
  checks.expect(
    'phase 3 the removed Workspace no longer accounts its Session',
    removed.childViewWorkspaceIdAfter == null,
    JSON.stringify(removed.childViewWorkspaceIdAfter),
  )
  checks.expect(
    'phase 3 re-registering the directory yields a new Workspace identity',
    typeof removed.reRegisteredWorkspaceId === 'string'
      && removed.reRegisteredWorkspaceId.length > 0
      && removed.reRegisteredWorkspaceId !== report.workspace?.workspaceId,
    `${String(removed.reRegisteredWorkspaceId)} vs ${String(report.workspace?.workspaceId)}`,
  )
  checks.expect(
    'phase 3 a new registration does not adopt the old Sessions',
    Array.isArray(removed.reRegisteredSessionIds) && !removed.reRegisteredSessionIds.includes(archivedChild),
    JSON.stringify(removed.reRegisteredSessionIds),
  )
  checks.expect(
    'phase 3 the Session stays ungrouped after re-registering the directory',
    removed.childViewWorkspaceIdAfterReRegister == null,
    JSON.stringify(removed.childViewWorkspaceIdAfterReRegister),
  )

  // The mode switch still hides the surface on the same running Host.
  const off = await client.command(leadId, '/devlead off')
  checks.expect('phase 3 /devlead off settles success', off?.result?.kind === 'success', off?.result?.text?.split('\n')[0])
  const inspectOffAgain = await runProbeCommand(client, leadId, PROBE_INSPECT_COMMAND)
  checks.expect(
    'phase 3 disabling the mode hides every devlead tool again',
    inspectOffAgain.report?.enabled === false
      && Array.isArray(inspectOffAgain.report?.devleadTools)
      && inspectOffAgain.report.devleadTools?.length === 0,
    JSON.stringify(inspectOffAgain.report?.devleadTools),
  )
  checks.expect(
    'phase 3 disabling the mode removes the devlead policy text',
    inspectOffAgain.report?.policy == null || String(inspectOffAgain.report.policy).trim().length === 0,
    JSON.stringify(inspectOffAgain.report?.policy),
  )

  // Lead off releases the board store; the Host publishes no board global.
  const boardStateOff = await runProbeCommand(client, leadId, PROBE_BOARD_STATE_COMMAND)
  checks.expect(
    'phase 3 disabling the mode releases the board store',
    boardStateOff.execution?.result?.kind === 'success'
      && boardStateOff.report?.enabled === false
      && boardStateOff.report?.boardPath === null
      && boardStateOff.report?.boardLeadSessionId === null
      && boardStateOff.report?.error?.code === 'DEVLEAD_NOT_ENABLED',
    boardStateOff.text.slice(0, 500),
  )
  const globalsAfterOff = await client.injectedGlobalNames()
  checks.expect(
    'phase 3 disabling the mode removes the board global',
    !globalsAfterOff.includes('__DSH_DEVLEAD_BOARD__'),
    JSON.stringify(globalsAfterOff),
  )

  checks.summarize(EXPECTED_CHECKS.phase3)
  return checks.results.length
}

/**
 * Run the Phase 1e message-lane checks against a fresh probe-loaded Host.
 *
 * A new lead is enabled on the same scratch home; each lane probe drains the
 * lead first so its assertions start from a quiet idle state. The probes drive
 * real reports/turns through `ctx.devLead` and the Host tools pipeline and read
 * every fact back from the durable Session log, the real read-tool output, and
 * the process-local metrics snapshot. Covers DESIGN §4.4.4/§4.4.7/§4.4.11/§4.4.12:
 * background no-wake inject (P1/P2), action-required steer wakes (P3/P4), the
 * T1 followup vs T2 review split, the question/turn-end double-wake merge, the
 * explicit 16-pair action cap overflow, and low-cardinality delivery metrics.
 * @param client - authenticated client of the phase-1e instance.
 * @param paths - scratch paths.
 * @returns the number of checks performed.
 */
async function runLaneChecks(client, paths) {
  const checks = new Checks()
  await client.login()

  const lead = await client.createSession(paths)
  const leadId = lead.sessionId
  checks.expect('phase 1e session/create returns a lead Session', typeof leadId === 'string' && leadId.length > 0, leadId)
  const on = await client.command(leadId, '/devlead on')
  checks.expect('phase 1e /devlead on settles success', on?.result?.kind === 'success', on?.result?.text?.split('\n')[0])
  const commands = await client.rpc('commands/list', { agentId: leadId })
  const laneCommandNames = [
    PROBE_LANES_BACKGROUND_COMMAND, PROBE_LANES_ACTION_COMMAND, PROBE_LANES_TURN_COMMAND,
    PROBE_LANES_MERGE_COMMAND, PROBE_LANES_RATE_COMMAND, PROBE_LANES_METRICS_COMMAND,
  ]
  checks.expect(
    'phase 1e lane probe commands are registered',
    laneCommandNames.every(name => commands.some(command => command.name === name)),
    JSON.stringify(laneCommandNames.filter(name => !commands.some(command => command.name === name))),
  )

  // --- P1/P2 background lane: inject, no wake, idle lead stays idle. ---
  const background = await runProbeCommand(client, leadId, PROBE_LANES_BACKGROUND_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e background probe settles success', background.execution?.result?.kind === 'success', background.text.slice(0, 500))
  const bg = background.report ?? {}
  const bgProgress = bg.progress ?? {}
  const bgFyi = bg.fyi ?? {}
  checks.expect(
    'phase 1e progress injects on the background lane at next-step without a wake',
    bgProgress.notice?.found === true
      && bgProgress.notice?.lane === 'background'
      && bgProgress.notice?.boundary === 'next-step'
      && bgProgress.notice?.wakeRequested === false
      && bgProgress.notice?.reportId === bgProgress.receipt?.report?.id
      && bgProgress.notice?.senderSessionId === bg.childId
      && String(bgProgress.notice?.text ?? '').includes('no action required and no wake was requested'),
    JSON.stringify({ ...bgProgress.notice, text: undefined }),
  )
  checks.expect(
    'phase 1e fyi injects on the background lane at next-step without a wake',
    bgFyi.notice?.found === true
      && bgFyi.notice?.lane === 'background'
      && bgFyi.notice?.boundary === 'next-step'
      && bgFyi.notice?.wakeRequested === false
      && bgFyi.notice?.reportId === bgFyi.receipt?.report?.id,
    JSON.stringify({ ...bgFyi.notice, text: undefined }),
  )
  checks.expect(
    'phase 1e idle lead stays idle: progress+fyi start no new lead turn',
    bg.leadStatusBefore === 'idle' && bg.leadStatusAfter === 'idle'
      && typeof bg.leadTurnBefore === 'number' && bg.leadTurnBefore === bg.leadTurnAfter,
    JSON.stringify({ before: `${String(bg.leadStatusBefore)}/${String(bg.leadTurnBefore)}`, after: `${String(bg.leadStatusAfter)}/${String(bg.leadTurnAfter)}` }),
  )
  checks.expect(
    'phase 1e background reports are observed delivered and durably receipted',
    bgProgress.deliveryState === 'delivered' && bgFyi.deliveryState === 'delivered'
      && bgProgress.receipt?.durable === true && bgFyi.receipt?.durable === true,
    JSON.stringify({ progress: bgProgress.deliveryState, fyi: bgFyi.deliveryState }),
  )
  const bgToolReports = Array.isArray(bg.notificationsTool?.value?.reports) ? bg.notificationsTool.value.reports : []
  checks.expect(
    'phase 1e devlead_notifications report rows carry lane background + deliveryState delivered',
    bg.notificationsTool?.isError === false
      && [bgProgress.receipt?.report?.id, bgFyi.receipt?.report?.id].every(id =>
        bgToolReports.some(row => row?.id === id && row?.lane === 'background' && row?.deliveryState === 'delivered')),
    JSON.stringify(bgToolReports.filter(row => row?.lane === 'background')),
  )
  const bgSelfReports = Array.isArray(bg.selfViewTool?.value?.reports) ? bg.selfViewTool.value.reports : []
  checks.expect(
    'phase 1e devlead_get_session self-read reports carry lane background + deliveryState',
    bg.selfViewTool?.isError === false
      && [bgProgress.receipt?.report?.id, bgFyi.receipt?.report?.id].every(id =>
        bgSelfReports.some(row => row?.id === id && row?.lane === 'background' && row?.deliveryState === 'delivered')),
    JSON.stringify(bgSelfReports.map(row => ({ id: row?.id, lane: row?.lane, deliveryState: row?.deliveryState }))),
  )

  // --- P3/P4 action-required lane: steer wakes carrying the full message. ---
  const action = await runProbeCommand(client, leadId, PROBE_LANES_ACTION_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e action probe settles success', action.execution?.result?.kind === 'success', action.text.slice(0, 500))
  const act = action.report ?? {}
  const actBlocked = act.blocked ?? {}
  const actDecision = act.decision ?? {}
  checks.expect(
    'phase 1e blocked report steers an action-required wake carrying the full message',
    actBlocked.wake?.found === true
      && actBlocked.wake?.lane === 'action-required'
      && actBlocked.wake?.boundary === 'next-step'
      && actBlocked.wake?.wakeRequested === true
      && actBlocked.wake?.reportId === actBlocked.receipt?.report?.id
      && String(actBlocked.wake?.excerpt ?? '').includes('[DEV LEAD ACTION REQUIRED]')
      && String(act.blockedMessage ?? '').split('\n').every(line => String(actBlocked.wake?.text ?? '').includes(`  ${line}`)),
    JSON.stringify({ ...actBlocked.wake, text: undefined }),
  )
  checks.expect(
    'phase 1e decision report steers an action-required wake carrying the full message',
    actDecision.wake?.found === true
      && actDecision.wake?.lane === 'action-required'
      && actDecision.wake?.wakeRequested === true
      && actDecision.wake?.reportId === actDecision.receipt?.report?.id
      && String(actDecision.wake?.text ?? '').includes(String(act.decisionMessage ?? '')),
    JSON.stringify({ ...actDecision.wake, text: undefined }),
  )
  checks.expect(
    'phase 1e action wake carries the report id and the observed child state',
    String(actBlocked.wake?.text ?? '').includes(`- report: ${String(actBlocked.receipt?.report?.id)}`)
      && String(actBlocked.wake?.text ?? '').includes('- observed child state at wake time:'),
    JSON.stringify({ text: String(actBlocked.wake?.text ?? '').slice(0, 600) }),
  )
  const actToolReports = Array.isArray(act.notificationsTool?.value?.reports) ? act.notificationsTool.value.reports : []
  checks.expect(
    'phase 1e notifications report rows carry lane action-required for blocked/decision',
    act.notificationsTool?.isError === false
      && [actBlocked.receipt?.report?.id, actDecision.receipt?.report?.id].every(id =>
        actToolReports.some(row => row?.id === id && row?.lane === 'action-required')),
    JSON.stringify(actToolReports.filter(row => row?.lane === 'action-required').map(row => ({ id: row?.id, kind: row?.kind }))),
  )

  // --- T1 completed followup vs T2 failed review steer. ---
  const turn = await runProbeCommand(client, leadId, PROBE_LANES_TURN_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e turn probe settles success', turn.execution?.result?.kind === 'success', turn.text.slice(0, 500))
  const turnReport = turn.report ?? {}
  const completed = turnReport.completed ?? {}
  const failed = turnReport.failed ?? {}
  checks.expect(
    'phase 1e completed turn settles completed and rides the turn-notice followup lane',
    completed.facts?.turnEndReason === 'completed' && completed.facts?.turnEnds === 1
      && completed.wake?.found === true
      && completed.wake?.lane === 'turn-notice'
      && completed.wake?.boundary === 'next-turn'
      && completed.wake?.wakeRequested === true
      && String(completed.wake?.excerpt ?? '').includes('[DEV LEAD NOTIFICATION]')
      && String(completed.wake?.text ?? '').includes(String(completed.facts?.childId)),
    JSON.stringify({ reason: completed.facts?.turnEndReason, wake: { ...completed.wake, text: undefined } }),
  )
  checks.expect(
    'phase 1e failed turn settles error and rides the action-required review steer lane',
    failed.facts?.turnEndReason === 'error' && failed.facts?.turnEnds === 1
      && failed.wake?.found === true
      && failed.wake?.lane === 'action-required'
      && failed.wake?.boundary === 'next-step'
      && failed.wake?.wakeRequested === true
      && String(failed.wake?.excerpt ?? '').includes('[DEV LEAD REVIEW REQUIRED]'),
    JSON.stringify({ reason: failed.facts?.turnEndReason, wake: { ...failed.wake, text: undefined } }),
  )
  checks.expect(
    'phase 1e review wake names the failed child and the failure/interruption',
    String(failed.wake?.text ?? '').includes(String(failed.facts?.childId))
      && String(failed.wake?.text ?? '').includes('failure or interruption'),
    JSON.stringify({ text: String(failed.wake?.text ?? '').slice(0, 600) }),
  )

  // --- Question + turn-end double-wake merge suppression fields. ---
  const merge = await runProbeCommand(client, leadId, PROBE_LANES_MERGE_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e merge probe settles success', merge.execution?.result?.kind === 'success', merge.text.slice(0, 500))
  const mergeReport = merge.report ?? {}
  const mergeFacts = mergeReport.merge ?? {}
  const mergedRow = mergeFacts.mergedRow ?? {}
  checks.expect(
    'phase 1e merged turn-end row carries wakeSuppressedByReportId + merged-into-pending-wake',
    mergeFacts.q1Id != null
      && mergedRow.wakeSuppressedByReportId === mergeFacts.q1Id
      && mergedRow.wakeSuppressionReason === 'merged-into-pending-wake'
      && mergedRow.id === `${String(mergeFacts.scriptedChildId)}:1:completed`,
    JSON.stringify({ q1Id: mergeFacts.q1Id, mergedRow }),
  )
  checks.expect(
    'phase 1e delivered question wake explicitly includes the merged turn-end line',
    mergeReport.q1Wake?.found === true
      && String(mergeReport.q1Wake?.text ?? '').includes('- included turn-end:')
      && String(mergeReport.q1Wake?.text ?? '').includes(String(mergeFacts.q1Id)),
    JSON.stringify({ ...mergeReport.q1Wake, text: String(mergeReport.q1Wake?.text ?? '').slice(0, 600) }),
  )
  const mergeToolNotifications = Array.isArray(mergeReport.notificationsTool?.value?.notifications)
    ? mergeReport.notificationsTool.value.notifications
    : []
  checks.expect(
    'phase 1e devlead_notifications output carries the suppression pair on the merged row',
    mergeReport.notificationsTool?.isError === false
      && mergeToolNotifications.some(row => row?.id === `${String(mergeFacts.scriptedChildId)}:1:completed`
        && row?.wakeSuppressedByReportId === mergeFacts.q1Id
        && row?.wakeSuppressionReason === 'merged-into-pending-wake'),
    JSON.stringify(mergeToolNotifications.filter(row => row?.wakeSuppressedByReportId !== undefined)),
  )

  // --- 16-pair action cap overflow is explicit (no silent drop). ---
  const rate = await runProbeCommand(client, leadId, PROBE_LANES_RATE_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e rate probe settles success', rate.execution?.result?.kind === 'success', rate.text.slice(0, 500))
  const rateFacts = rate.report?.rate ?? {}
  checks.expect(
    'phase 1e 17 distinct action reports are accepted and every receipt stays durable',
    rateFacts.acceptedCount === 17 && rateFacts.acceptedAllDurable === true,
    JSON.stringify({ acceptedCount: rateFacts.acceptedCount, acceptedAllDurable: rateFacts.acceptedAllDurable }),
  )
  checks.expect(
    'phase 1e the 18th distinct report is refused with DEVLEAD_DELIVERY_RATE_LIMITED (no silent drop)',
    rateFacts.refusedCount === 1
      && JSON.stringify(rateFacts.refusedCodes) === JSON.stringify(['DEVLEAD_DELIVERY_RATE_LIMITED']),
    JSON.stringify({ refusedCount: rateFacts.refusedCount, refusedCodes: rateFacts.refusedCodes }),
  )

  // --- Low-cardinality delivery/suppression/guard metrics. ---
  const metrics = await runProbeCommand(client, leadId, PROBE_LANES_METRICS_COMMAND, DISPATCH_PROBE_TIMEOUT_MS)
  checks.expect('phase 1e metrics probe settles success', metrics.execution?.result?.kind === 'success', metrics.text.slice(0, 500))
  const snapshot = Array.isArray(metrics.report?.snapshot) ? metrics.report.snapshot : []
  const hasSeries = (name, labels) => snapshot.some(sample => sample?.name === name
    && Object.entries(labels).every(([key, value]) => sample?.labels?.[key] === value))
  checks.expect(
    'phase 1e delivery totals exist per lane/outcome (background/action/turn-notice delivered + rate-limited)',
    hasSeries('devlead_delivery_total', { lane: 'background', outcome: 'delivered' })
      && hasSeries('devlead_delivery_total', { lane: 'action-required', outcome: 'delivered' })
      && hasSeries('devlead_delivery_total', { lane: 'turn-notice', outcome: 'delivered' })
      && hasSeries('devlead_delivery_total', { lane: 'action-required', outcome: 'rate-limited' }),
    JSON.stringify(snapshot.filter(sample => sample?.name === 'devlead_delivery_total').map(sample => sample.labels)),
  )
  checks.expect(
    'phase 1e suppression and guard counters exist (merged wake + queued-action guard)',
    hasSeries('devlead_wake_suppression_total', { reason: 'merged-into-pending-wake' })
      && hasSeries('devlead_guard_hit_total', { guard: 'queued-action-required' }),
    JSON.stringify(snapshot.filter(sample => sample?.name !== 'devlead_delivery_total')),
  )
  const allowedLabelKeys = new Set(['direction', 'lane', 'primitive', 'kind', 'outcome', 'reason', 'guard', 'status', 'overflow'])
  checks.expect(
    'phase 1e metrics labels are low-cardinality enums only (no ids or message text)',
    snapshot.length > 0 && snapshot.every((sample) => {
      const labels = sample?.labels ?? {}
      return Object.keys(labels).every(key => allowedLabelKeys.has(key))
        && Object.values(labels).every(value => typeof value === 'string' && !value.includes(':') && value.length <= 40)
    }),
    JSON.stringify(snapshot.flatMap(sample => Object.entries(sample?.labels ?? {})).filter(([, value]) => String(value).includes(':') || String(value).length > 40)),
  )

  const off = await client.command(leadId, '/devlead off')
  checks.expect(
    'phase 1e /devlead off releases the global slot',
    off?.result?.kind === 'success' && /DevLead mode disabled\./u.test(off?.result?.text ?? ''),
    off?.result?.text?.split('\n')[0],
  )

  checks.summarize(EXPECTED_CHECKS.phase1e)
  return checks.results.length
}

/**
 * Report one failed phase with the runtime log tail and keep the scratch root
 * for inspection.
 * @param flow - loading flow label ("patch"/"installed").
 * @param phase - human-readable phase label.
 * @param error - thrown failure.
 * @param logPath - phase log file, when the runtime was started.
 * @param paths - scratch paths.
 */
function reportPhaseFailure(flow, phase, error, logPath, paths) {
  console.error(`\nE2E SMOKE FAIL (${flow}, ${phase}): ${messageOf(error)}`)
  if (logPath !== undefined && existsSync(logPath)) {
    const tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-25).join('\n')
    console.error(`--- tail of ${logPath} ---\n${tail}`)
  }
  console.error(`--- scratch root kept at ${paths.base} ---`)
  process.exitCode = 1
}

/** Run one flow end-to-end (all phases) and tear every booted instance down. */
async function runFlow(options) {
  const dshBinary = resolveDshBinary()
  const dshVersion = requireDshVersion(dshBinary)
  buildPackages(options)
  const paths = prepareScratch(options)
  initScratchRepository(paths)
  console.log(`e2e-smoke: flow ${options.flow}, DeepSeek Harness ${dshVersion}`)
  console.log(`e2e-smoke: scratch root ${paths.base}`)

  try {
    createProfile(paths, dshBinary)
    /** Phase-1 `--patch` overlay of the patch flow; later phases keep it. */
    let devleadOverlay
    if (options.flow === 'patch') devleadOverlay = writePatchOverlay(paths)
    else installProfile(paths)
    const boardOverlay = writeBoardConfigPatch(paths)
    // Phase 1 and 1b boot the shipped default composition with the board
    // disabled (no board overlay), so the negative no-global assertion above
    // exercises the real default. Later phases configure the scratch board.
    const phaseOnePatches = devleadOverlay === undefined ? [] : [devleadOverlay]

    // ------------------------------------------------------------------------
    // Phase 1: the shipped default composition (no experimental bundle).
    // ------------------------------------------------------------------------
    console.log('\n=== phase 1: default Web composition ===')
    const phaseOne = await startWeb(paths, dshBinary, options, { label: '', patches: phaseOnePatches })
    console.log(`e2e-smoke: phase 1 web ${redactUrl(phaseOne.url)}`)
    let phaseOneState
    try {
      phaseOneState = await runChecks(new WebClient(phaseOne.url), paths)
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 1', error, phaseOne.logPath, paths)
      await stopInstance(phaseOne.child)
      return
    }
    await stopInstance(phaseOne.child)
    console.log(`e2e-smoke: phase 1 passed (${String(phaseOneState.count)} checks; mode/watch/digest left durable)`)

    // ------------------------------------------------------------------------
    // Phase 1b: cold lead rehydration on a restarted Host, same scratch home.
    // ------------------------------------------------------------------------
    console.log('\n=== phase 1b: cold lead rehydration after restart ===')
    const phaseOneB = await startWeb(paths, dshBinary, options, { label: 'phase1b', patches: phaseOnePatches })
    console.log(`e2e-smoke: phase 1b web ${redactUrl(phaseOneB.url)}`)
    let phaseOneBCount = 0
    try {
      phaseOneBCount = await runRehydrationChecks(new WebClient(phaseOneB.url), paths, phaseOneState)
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 1b', error, phaseOneB.logPath, paths)
      await stopInstance(phaseOneB.child)
      return
    }
    await stopInstance(phaseOneB.child)
    console.log(`e2e-smoke: phase 1b passed (${String(phaseOneBCount)} checks)`)

    // The probe package/patch serves phase 2 and phase 3; setting it up is
    // idempotent, so the close phase also runs when the worktree phase is
    // skipped (the close tools do not depend on the experimental bundle).
    let phaseTwoCount
    let probePatch
    if (options.worktree) {
      // ----------------------------------------------------------------------
      // Phase 2: same scratch root/profile, experimental worktree composition.
      // ----------------------------------------------------------------------
      console.log('\n=== phase 2: experimental worktree composition ===')
      const bundle = enableWorktreeBundle(paths)
      const probeLink = linkProbePackage(paths)
      probePatch = writeProbePatch(paths)
      console.log(`e2e-smoke: selected ${bundle}; linked probe ${probeLink}`)
      // The patch flow keeps its devlead overlay and adds the probe overlay after
      // it; the installed flow's devlead rows come from the profile bundle list,
      // so the probe overlay is its only `--patch`.
      const patches = devleadOverlay === undefined
        ? [probePatch, boardOverlay]
        : [devleadOverlay, probePatch, boardOverlay]
      let phaseTwo
      try {
        phaseTwo = await startWeb(paths, dshBinary, options, { label: 'worktree', patches })
      } catch (error) {
        reportPhaseFailure(options.flow, 'phase 2 boot', error, undefined, paths)
        return
      }
      console.log(`e2e-smoke: phase 2 web ${redactUrl(phaseTwo.url)}`)
      try {
        phaseTwoCount = await runWorktreeChecks(new WebClient(phaseTwo.url), paths)
      } catch (error) {
        reportPhaseFailure(options.flow, 'phase 2', error, phaseTwo.logPath, paths)
      } finally {
        await stopInstance(phaseTwo.child)
      }
      if (process.exitCode === 1) return
    } else {
      console.log('\n=== phase 2 skipped (--no-worktree) ===')
      linkProbePackage(paths)
      probePatch = writeProbePatch(paths)
    }

    // ------------------------------------------------------------------------
    // Phase 3: close tools and triage policy, same scratch root/profile.
    // ------------------------------------------------------------------------
    console.log('\n=== phase 3: close tools, dispatch routing, and triage policy ===')
    // Phase 3 deliberately runs WITHOUT the board overlay: the default
    // derivation must put the board under the lead Session workspace, while
    // phase 2 covers the configured override.
    const closePatches = devleadOverlay === undefined
      ? [probePatch]
      : [devleadOverlay, probePatch]
    let phaseThree
    try {
      phaseThree = await startWeb(paths, dshBinary, options, { label: 'close', patches: closePatches })
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 3 boot', error, undefined, paths)
      return
    }
    console.log(`e2e-smoke: phase 3 web ${redactUrl(phaseThree.url)}`)
    let phaseThreeCount = 0
    try {
      phaseThreeCount = await runCloseChecks(new WebClient(phaseThree.url), paths, dshVersion)
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 3', error, phaseThree.logPath, paths)
    } finally {
      await stopInstance(phaseThree.child)
    }
    if (process.exitCode === 1) return

    // ------------------------------------------------------------------------
    // Phase 1e: message-lane delivery (background/action/turn-notice), the
    // double-wake merge, the explicit action cap, and metrics. Same scratch
    // root/profile with the probe overlay; a fresh lead isolates lane state.
    // ------------------------------------------------------------------------
    console.log('\n=== phase 1e: message lanes, merge, action cap, and metrics ===')
    const lanePatches = devleadOverlay === undefined
      ? [probePatch, boardOverlay]
      : [devleadOverlay, probePatch, boardOverlay]
    let phaseOneE
    try {
      phaseOneE = await startWeb(paths, dshBinary, options, { label: 'lanes', patches: lanePatches })
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 1e boot', error, undefined, paths)
      return
    }
    console.log(`e2e-smoke: phase 1e web ${redactUrl(phaseOneE.url)}`)
    let phaseOneECount = 0
    try {
      phaseOneECount = await runLaneChecks(new WebClient(phaseOneE.url), paths)
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 1e', error, phaseOneE.logPath, paths)
    } finally {
      await stopInstance(phaseOneE.child)
    }
    if (process.exitCode === 1) return
    const total = phaseOneState.count + phaseOneBCount + (phaseTwoCount ?? 0) + phaseThreeCount + phaseOneECount
    const expectedTotal = EXPECTED_CHECKS.phase1 + EXPECTED_CHECKS.phase1b
      + (options.worktree ? EXPECTED_CHECKS.phase2 : 0) + EXPECTED_CHECKS.phase3 + EXPECTED_CHECKS.phase1e
    console.log(`\nE2E SMOKE PASS (${options.flow}, DeepSeek Harness ${dshVersion})`)
    if (dshVersion !== BASELINE_DSH_VERSION) {
      console.log(`  note: pinned check totals are verified against ${BASELINE_DSH_VERSION}; this run used ${dshVersion}`)
    }
    console.log(`  phase 1 (default profile): ${String(phaseOneState.count)}/${String(EXPECTED_CHECKS.phase1)} checks`)
    console.log(`  phase 1b (cold lead rehydration): ${String(phaseOneBCount)}/${String(EXPECTED_CHECKS.phase1b)} checks`)
    if (phaseTwoCount !== undefined) {
      console.log(`  phase 2 (experimental worktree composition): ${String(phaseTwoCount)}/${String(EXPECTED_CHECKS.phase2)} checks`)
    }
    console.log(`  phase 3 (close tools, dispatch routing, and triage policy): ${String(phaseThreeCount)}/${String(EXPECTED_CHECKS.phase3)} checks`)
    console.log(`  phase 1e (message lanes, merge, action cap, metrics): ${String(phaseOneECount)}/${String(EXPECTED_CHECKS.phase1e)} checks`)
    console.log(`  total: ${String(total)}/${String(expectedTotal)} checks (PASS + SKIP; see per-phase lines)${options.worktree ? '' : '; phase 2 skipped (--no-worktree)'}; logs: ${paths.logs}`)
  } catch (error) {
    console.error(`\nE2E SMOKE FAIL (${options.flow}): ${messageOf(error)}`)
    console.error(`--- scratch root kept at ${paths.base} ---`)
    process.exitCode = 1
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  await runFlow(options)
} catch (error) {
  console.error(`e2e-smoke: ${messageOf(error)}`)
  process.exit(1)
}
