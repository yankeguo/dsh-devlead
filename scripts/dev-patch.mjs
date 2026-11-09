#!/usr/bin/env node
/**
 * Generate a DSH profile patch overlay that inserts every built devlead plugin
 * by absolute filesystem path, and register this checkout as a linked root in
 * the target profile.
 *
 * Why the link: absolute-path rows load code from this checkout, so their
 * `@deepseek-ai/*` imports would resolve through the checkout's own pnpm
 * `node_modules` — a second DSH runtime copy inside the host process. The first
 * cross-copy private check then fails (for example
 * `gateway/internal: Receiver must be an instance of class Session`). A symlink
 * under the active profile's `node_modules` to this checkout makes DSH treat
 * the checkout as a linked root: importers below it get peer-aware resolution,
 * and every dependency the importing package declares under
 * `peerDependencies` is routed to the installation's instance instead of the
 * physical copy. This is the official mechanism in DSH app-boot
 * (`packages/boot/app-boot/README.md`, "Linked directories"), so every
 * workspace package declares its `@deepseek-ai/*` runtime imports as peers.
 *
 * Usage:
 *   node scripts/dev-patch.mjs [--profile <name>] [--dsh-home <dir>] [--no-link]
 *
 * Defaults: `--profile web`, `--dsh-home $DSH_HOME` or `~/.dsh`.
 * The emitted overlay needs no npm publishing and no profile dependency
 * install. Boot the composed profile with:
 *
 *   DSH_HOME=<dsh-home> dsh --profile <name> --patch <repo>/.tmp/cordis.patch.yml
 *
 * The overlay inserts the core service, tools, command, and browser UI rows.
 * None of the rows writes a `config` block, so the core service uses its schema
 * defaults; to exercise non-default settings, append a `config:` block to the
 * `devlead` row and restate every field you keep (DSH replaces a row's whole
 * config). `--no-link` emits the overlay only and is useful for inspecting it,
 * never for a working dev boot.
 *
 * Paths are emitted as YAML double-quoted scalars (JSON is a YAML subset), so a
 * checkout living under a directory with spaces or YAML-significant characters
 * still produces a loadable patch.
 */
import {
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const OUT = join(ROOT, '.tmp', 'cordis.patch.yml')
/** Name of the linked-root symlink inside the profile's `node_modules`. */
const LINK_NAME = 'devlead-repo'
/** Bundle package whose selection would insert the same Loader row ids. */
const MAIN_BUNDLE = '@yankeguo/dsh-devlead-bundle'

/** One inserted Loader row. */
const ROWS = [
  { id: 'devlead', dir: 'devlead' },
  { id: 'devlead-tool', dir: 'tool' },
  { id: 'devlead-command', dir: 'command' },
  { id: 'devlead-ui', dir: 'client-ui', client: true },
]

/** Expand a leading `~` so a quoted `--dsh-home '~/...'` still resolves. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Whether one path is an existing symbolic link. */
function isSymlink(path) {
  try {
    readlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Refuse to start when the linked-root path cannot be created, before anything
 * is written.
 * @param profileDir - absolute profile directory.
 * @returns absolute path of the linked root.
 */
function assertLinkWritable(profileDir) {
  const linkPath = join(profileDir, 'node_modules', LINK_NAME)
  if (isSymlink(linkPath)) return linkPath
  if (existsSync(linkPath)) {
    throw new Error(`${linkPath} exists and is not a symlink; refusing to replace it (remove it and rerun)`)
  }
  return linkPath
}

/**
 * Parse command-line arguments.
 * @param argv - arguments after the script path.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: expandHome(process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    link: true,
  }
  let index = 0
  /** Read the value of a `--flag value` pair and reject a missing/flag value. */
  const valueOf = (flag) => {
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = valueOf('--profile')
        break
      case '--dsh-home':
        options.dshHome = expandHome(valueOf('--dsh-home'))
        break
      case '--no-link':
        options.link = false
        break
      case '--help':
      case '-h':
        console.log('Usage: node scripts/dev-patch.mjs [--profile <name>] [--dsh-home <dir>] [--no-link]')
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  options.dshHome = resolve(options.dshHome)
  if (options.profile.trim().length === 0 || options.profile === '.' || options.profile === '..'
    || options.profile.includes('/') || options.profile.includes('\\') || options.profile === 'node_modules') {
    throw new Error(`--profile: invalid profile name ${JSON.stringify(options.profile)}`)
  }
  return options
}

/**
 * Resolve one row's built host entry.
 * @param row - row declaration.
 * @returns absolute path of the built entry.
 * @throws when the package was not built yet.
 */
function entryOf(row) {
  const entry = join(ROOT, 'packages', row.dir, 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error(`missing built entry ${entry} (run "pnpm build" first)`)
  if (row.client === true) {
    const clientEntry = join(ROOT, 'packages', row.dir, 'lib', 'client.js')
    if (!existsSync(clientEntry)) throw new Error(`missing built browser entry ${clientEntry} (run "pnpm build" first)`)
  }
  return entry
}

/** Render one row as YAML, using the absolute built entry path. */
function renderRow(row) {
  return [`    - id: ${row.id}`, `      name: ${JSON.stringify(entryOf(row))}`].join('\n')
}

/**
 * Validate the target profile and return its directory.
 * @param options - parsed options.
 * @returns absolute profile directory.
 * @throws when the profile is absent, malformed, or already enables the bundle.
 */
function profileDirectory(options) {
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `profile "${options.profile}" not found at ${profileDir}\n`
      + 'create a dedicated dev profile once (do not reuse "desktop": it already enables the bundle):\n'
      + `  DSH_HOME=${options.dshHome} dsh devlead --from-default-profile web --dump-config\n`
      + 'then rerun:\n'
      + `  node scripts/dev-patch.mjs --profile devlead --dsh-home ${options.dshHome}\n`
      + 'and boot the command it prints.',
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must hold a JSON object`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    throw new Error(`${manifestPath} has a non-array dsh.profile.bundles; refusing to guess`)
  }
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (bundle === MAIN_BUNDLE) {
      throw new Error(
        `profile "${options.profile}" already enables ${bundle};\n`
        + 'the dev overlay inserts the same Loader row ids, so combining both would duplicate rows.\n'
        + `create a dedicated dev profile instead:\n`
        + `  DSH_HOME=${options.dshHome} dsh devlead --from-default-profile web --dump-config\n`
        + 'then rerun this script with --profile devlead.',
      )
    }
  }
  return profileDir
}

/**
 * Register this checkout as a linked root under the profile's `node_modules`.
 * Idempotent: an existing link to the same checkout is kept and a link to
 * another checkout is replaced.
 * @param linkPath - preflighted linked-root path.
 * @returns absolute path of the linked root.
 */
async function linkRoot(linkPath) {
  if (isSymlink(linkPath)) {
    const current = resolve(dirname(linkPath), readlinkSync(linkPath))
    if (current === ROOT) return linkPath
    unlinkSync(linkPath)
  } else {
    await mkdir(dirname(linkPath), { recursive: true })
  }
  symlinkSync(ROOT, linkPath, 'dir')
  return linkPath
}

try {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = profileDirectory(options)
  const linkPath = options.link ? assertLinkWritable(profileDir) : undefined
  const text = [
    '# Generated by `pnpm dev:patch` — development overlay for the devlead plugin suite.',
    '# Insert rows use absolute built entry paths, so no profile install is required.',
    `# The profile also needs the linked root "node_modules/${LINK_NAME}" -> ${ROOT}`,
    '# (added by this script; it keeps the host and the plugins on one DSH runtime).',
    '- insert:',
    ...ROWS.map(renderRow),
    '',
  ].join('\n')
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text)
  console.log(text)
  console.log(`wrote ${OUT}`)
  if (linkPath !== undefined) {
    await linkRoot(linkPath)
    console.log(`linked ${linkPath} -> ${ROOT}`)
  } else {
    console.warn(
      'warning: --no-link skips the linked root; absolute-path rows would resolve @deepseek-ai/*\n'
      + 'from this checkout and create a second DSH runtime copy. The overlay is inspect-only.',
    )
  }
  console.log('boot with:')
  console.log(`  DSH_HOME=${options.dshHome} dsh --profile ${options.profile} --patch ${OUT} --no-open`)
} catch (error) {
  console.error(`dev-patch: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
