#!/usr/bin/env node
/**
 * Isolated end-to-end smoke test of the built DevLead plugin suite against the
 * installed DeepSeek Harness Web runtime.
 *
 * It boots a throwaway DSH_HOME under the OS temp directory (never `~/.dsh`),
 * loads the suite through one of the two documented local flows, logs in with
 * the launch token over the same HTTP API the browser uses, and asserts the
 * product behaviors that only appear in a real Host:
 *
 *   - the browser half is discovered (boot graph client entry + declared injects);
 *   - `/devlead` is a registered human command and the `devLead` projection is
 *     served with its default wire value;
 *   - `/devlead on` / `/devlead off` flip the durable mode and the projection
 *     follows it;
 *   - `watch` addresses a real child Session and self-watch is rejected;
 *   - a watched child `turn/end` writes a durable notification into the lead
 *     Session and the projection exposes it.
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
 * The child Session is prompted with every known model-provider credential
 * removed from the child environment, so its turn settles deterministically as
 * a provider error: a real `turn/end` event that produces a real notification
 * without spending tokens.
 *
 * This is a LOCAL acceptance harness: it requires the installed DSH desktop
 * runtime (or `DSH_BIN`) and never runs in CI.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs [--flow patch|installed] [--no-build]
 *                              [--root <dir>] [--port <n>] [--verbose]
 *
 * Environment:
 *   DSH_BIN   CLI to boot (default: `dsh` on PATH, for example the packaged
 *             `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`)
 *
 * Exit code 0 when every check passes and the spawned instance is torn down.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Scratch directory and throwaway profile name. */
const SCRATCH_NAME = 'devlead-e2e'
/** Name of the profile `node_modules` link that registers the checkout as a linked root. */
const REPO_LINK_NAME = 'devlead-repo'
/** Environment variables that would let the child Session reach a real model provider. */
const PROVIDER_KEY_VARIABLES = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DASHSCOPE_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'ZHIPU_API_KEY',
]
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

const USAGE = `Usage: node scripts/e2e-smoke.mjs [options]

Options:
  --flow <patch|installed>  loading flow to exercise (default: patch)
  --no-build                reuse the current packages/*/lib artifacts
  --root <dir>              scratch directory under ${tmpdir()} (default: a unique one)
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

/** Parse the command line, exiting on invalid input or an explicit help request. */
function parseArgs(argv) {
  const options = {
    flow: 'patch',
    build: true,
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
  const base = options.root ?? join(tmpdir(), `${SCRATCH_NAME}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  if (!base.startsWith(tmpdir())) throw new Error(`the scratch root must live under ${tmpdir()}, got ${base}`)
  if (options.root !== undefined && existsSync(base)) rmSync(base, { recursive: true, force: true })
  const paths = {
    base,
    home: join(base, 'home'),
    logs: join(base, 'logs'),
    workspace: join(base, 'workspace'),
    config: join(base, 'config'),
  }
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  return paths
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
  return join(paths.home, 'profiles', SCRATCH_NAME, 'node_modules', REPO_LINK_NAME)
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

/** Build the child environment with every known model-provider credential removed. */
function childEnvironment(paths) {
  const env = { ...process.env, DSH_HOME: paths.home }
  for (const name of PROVIDER_KEY_VARIABLES) delete env[name]
  return env
}

/**
 * Spawn the isolated Web runtime and resolve its tokenized launch URL.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, logPath: string }>}
 *   spawned process, launch URL, and the log file receiving its output.
 */
async function startWeb(paths, dshBinary, options) {
  const args = ['--profile', SCRATCH_NAME]
  if (options.flow === 'patch') args.push('--patch', join(paths.config, 'devlead.patch.yml'))
  args.push('--no-open', '--host', '127.0.0.1', '--port', String(options.port))
  const logPath = join(paths.logs, `web-${options.flow}.log`)
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

/** Run every product check against the booted instance. */
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

  const on = await client.command(leadId, '/devlead on')
  checks.expect('/devlead on settles success', on?.result?.kind === 'success', on?.result?.text?.split('\n')[0])
  checks.expect('/devlead on reports the enabled mode', /DevLead mode enabled\./u.test(on?.result?.text ?? ''))
  const projection1 = (await client.projections(leadId))?.values?.devLead
  checks.expect('projection reports enabled after /devlead on', projection1?.enabled === true)

  const status = await client.command(leadId, '/devlead status')
  checks.expect('/devlead status prints the enabled mode', /DevLead mode: on/u.test(status?.result?.text ?? ''))

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

  const statusAfter = await client.command(leadId, '/devlead status')
  checks.expect('/devlead status lists the recent notification', /Recent notifications:/u.test(statusAfter?.result?.text ?? ''))
  checks.expect('/devlead status lists the watched child', (statusAfter?.result?.text ?? '').includes(childId))

  const off = await client.command(leadId, '/devlead off')
  checks.expect('/devlead off settles success', off?.result?.kind === 'success', off?.result?.text?.split('\n')[0])
  checks.expect('/devlead off reports the disabled mode', /DevLead mode disabled\./u.test(off?.result?.text ?? ''))
  const projection3 = (await client.projections(leadId))?.values?.devLead
  checks.expect('projection reports disabled after /devlead off', projection3?.enabled === false)

  checks.summarize()
}

/** Run one flow end-to-end and tear the instance down. */
async function runFlow(options) {
  const dshBinary = resolveDshBinary()
  const dshVersion = requireDshVersion(dshBinary)
  buildPackages(options)
  const paths = prepareScratch(options)
  console.log(`e2e-smoke: flow ${options.flow}, DeepSeek Harness ${dshVersion}`)
  console.log(`e2e-smoke: scratch root ${paths.base}`)

  createProfile(paths, dshBinary)
  if (options.flow === 'patch') writePatchOverlay(paths)
  else installProfile(paths)

  const { child, url, logPath } = await startWeb(paths, dshBinary, options)
  console.log(`e2e-smoke: web ${url.replace(/\?token=.*$/u, '?token=…')}`)
  try {
    await runChecks(new WebClient(url), paths)
    console.log(`\nE2E SMOKE PASS (${options.flow}); logs: ${paths.logs}`)
  } catch (error) {
    console.error(`\nE2E SMOKE FAIL (${options.flow}): ${messageOf(error)}`)
    if (existsSync(logPath)) {
      const tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-25).join('\n')
      console.error(`--- tail of ${logPath} ---\n${tail}`)
    }
    console.error(`--- scratch root kept at ${paths.base} ---`)
    process.exitCode = 1
  } finally {
    await stopInstance(child)
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  await runFlow(options)
} catch (error) {
  console.error(`e2e-smoke: ${messageOf(error)}`)
  process.exit(1)
}
