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
 * Every flow runs three phases against the same scratch root and the same
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
 *               - `/devlead status` reports `Worktree isolation: unavailable`.
 *             27 checks. The final `/devlead status` + `/devlead off` checks
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
 *               - the resumed, now-live lead answers `/devlead status` (watched
 *                 child + recent notification) and the final `/devlead off`.
 *             12 checks.
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
 *             the registered Workspace. The scratch workspace is a real Git
 *             repository (one seed commit) because the worktree service
 *             branches from its `HEAD`.
 *             22 checks.
 *
 * `--no-worktree` runs phases 1 + 1b only (debugging escape hatch when the
 * experimental composition cannot boot on this machine).
 *
 * Check counts: phase 1 = 27, phase 1b = 12, phase 2 = 22, so every flow
 * reports 61/61 checks when all three phases pass (`--no-worktree` stops after
 * phase 1b: 39/39). Run both flows before a release:
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
/** Private E2E probe package in `scripts/e2e-probe`, linked as a profile package in phase 2. */
const PROBE_PACKAGE = '@yankeguo/dsh-devlead-e2e-probe'
/** Command the probe registers; phase 2 dispatches `/${PROBE_COMMAND}`. */
const PROBE_COMMAND = 'devlead-e2e-worktree'
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

const USAGE = `Usage: node scripts/e2e-smoke.mjs [options]

Options:
  --flow <patch|installed>  loading flow to exercise (default: patch)
  --no-build                reuse the current packages/*/lib artifacts
  --no-worktree             run phases 1 + 1b only; skip the experimental worktree
                            composition (debugging escape hatch, the default runs
                            all three phases)
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

  /** Read the index HTML and return the injected boot graph. */
  async bootGraph() {
    const response = await fetch(`${this.origin}/`, { headers: { cookie: this.#cookie } })
    if (response.status !== 200) throw new Error(`GET / answered HTTP ${response.status}`)
    const html = await response.text()
    const marker = 'globalThis["__DSH_BOOT__"]'
    const markerIndex = html.indexOf(marker)
    const equalsIndex = markerIndex < 0 ? -1 : html.indexOf('=', markerIndex + marker.length)
    const scriptEnd = equalsIndex < 0 ? -1 : html.indexOf('</script>', equalsIndex)
    if (markerIndex < 0 || equalsIndex < 0 || scriptEnd < 0) {
      throw new Error('index HTML does not carry the injected __DSH_BOOT__ graph')
    }
    let jsonText = html.slice(equalsIndex + 1, scriptEnd).trim()
    if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1).trim()
    return JSON.parse(jsonText)
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
      const body = await response.text()
      if (response.status !== 200) throw new Error(`${method} answered HTTP ${response.status}: ${body.slice(0, 300)}`)
      let envelope
      try {
        envelope = JSON.parse(body)
      } catch (error) {
        throw new Error(`${method} returned non-JSON (${messageOf(error)}): ${body.slice(0, 300)}`)
      }
      if (envelope?.result?.ok !== true) {
        const code = envelope?.result?.error?.code ?? 'unknown'
        const message = envelope?.result?.error?.message ?? body.slice(0, 300)
        throw new Error(`${method} failed: ${code}: ${message}`)
      }
      return envelope.result.value
    } finally {
      clearTimeout(timer)
    }
  }

  /** Create one ordinary Session in the scratch workspace. */
  async createSession(paths) {
    return await this.rpc('session/create', { request: { cwd: paths.workspace } })
  }

  /** Execute one `/devlead` command line for a Session Agent. */
  async command(agentId, line) {
    return await this.rpc('commands/execute', { agentId, line, submittedAttachments: [] })
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

  /** Fail with the collected check list when anything failed. */
  summarize() {
    const failed = this.results.filter(result => !result.ok)
    console.log(`\n${this.results.length - failed.length}/${this.results.length} checks passed`)
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

  checks.summarize()
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

  checks.summarize()
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

  checks.summarize()
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

    if (!options.worktree) {
      const phaseOneTotal = phaseOneState.count + phaseOneBCount
      console.log(`\nE2E SMOKE PASS (${options.flow})`)
      console.log(`  phase 1 (default profile): ${String(phaseOneState.count)}/${String(phaseOneState.count)} checks`)
      console.log(`  phase 1b (cold lead rehydration): ${String(phaseOneBCount)}/${String(phaseOneBCount)} checks`)
      console.log(`  total: ${String(phaseOneTotal)}/${String(phaseOneTotal)} checks; phase 2 skipped (--no-worktree)`)
      console.log(`logs: ${paths.logs}`)
      return
    }

    // ------------------------------------------------------------------------
    // Phase 2: same scratch root/profile, experimental worktree composition.
    // ------------------------------------------------------------------------
    console.log('\n=== phase 2: experimental worktree composition ===')
    const bundle = enableWorktreeBundle(paths)
    const probeLink = linkProbePackage(paths)
    const probePatch = writeProbePatch(paths)
    console.log(`e2e-smoke: selected ${bundle}; linked probe ${probeLink}`)
    // The patch flow keeps its devlead overlay and adds the probe overlay after
    // it; the installed flow's devlead rows come from the profile bundle list,
    // so the probe overlay is its only `--patch`.
    const patches = devleadOverlay === undefined ? [probePatch] : [devleadOverlay, probePatch]
    let phaseTwo
    try {
      phaseTwo = await startWeb(paths, dshBinary, options, { label: 'worktree', patches })
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 2 boot', error, undefined, paths)
      return
    }
    console.log(`e2e-smoke: phase 2 web ${redactUrl(phaseTwo.url)}`)
    let phaseTwoCount = 0
    try {
      phaseTwoCount = await runWorktreeChecks(new WebClient(phaseTwo.url), paths)
    } catch (error) {
      reportPhaseFailure(options.flow, 'phase 2', error, phaseTwo.logPath, paths)
    } finally {
      await stopInstance(phaseTwo.child)
    }
    if (process.exitCode === 1) return
    const total = phaseOneState.count + phaseOneBCount + phaseTwoCount
    console.log(`\nE2E SMOKE PASS (${options.flow})`)
    console.log(`  phase 1 (default profile): ${String(phaseOneState.count)}/${String(phaseOneState.count)} checks`)
    console.log(`  phase 1b (cold lead rehydration): ${String(phaseOneBCount)}/${String(phaseOneBCount)} checks`)
    console.log(`  phase 2 (experimental worktree composition): ${String(phaseTwoCount)}/${String(phaseTwoCount)} checks`)
    console.log(`  total: ${String(total)}/${String(total)} checks; logs: ${paths.logs}`)
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
