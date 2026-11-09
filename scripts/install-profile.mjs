#!/usr/bin/env node
/**
 * Link the built devlead plugin suite into a DSH profile.
 *
 * This is the self-install path for a local checkout:
 *   - symlinks every `@yankeguo/dsh-*` workspace package into
 *     `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`;
 *   - appends the bundle package to the profile's `dsh.profile.bundles`.
 *
 * Those symlinks are also DSH linked roots: importers below them get
 * peer-aware resolution, so the plugin packages share the installation's
 * `@deepseek-ai/*` instances instead of loading a second DSH runtime from the
 * checkout's pnpm `node_modules` (see DSH
 * `packages/boot/app-boot/README.md`, "Linked directories").
 *
 * The write is idempotent: the profile manifest is only rewritten (and only
 * backed up) when its content actually changes, so repeated runs leave no
 * backup clutter. A dry run plans and validates everything without writing.
 * Every collision is detected before the first mutation, so a failed run never
 * leaves a half-linked profile.
 *
 * A profile installed through the plugin manager owns real package directories
 * (pnpm layout). Those installed copies are left untouched and reported; the
 * local checkout is only linked where no equivalent installed package exists.
 *
 * `--uninstall` removes the links and the bundle selection, again only writing
 * when something actually changes.
 *
 * The profile's HMR composes host-plugin changes live; restart DSH once so
 * every existing session is bound to the new preset revisions, and reload the
 * Web page so the browser half loads.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile desktop] [--dsh-home ~/.dsh]
 *                                    [--uninstall] [--dry-run]
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_BUNDLE = '@yankeguo/dsh-devlead-bundle'

/**
 * Parse `--flag value` and boolean `--flag` arguments.
 * @param argv - arguments after `node scripts/install-profile.mjs`.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const options = {
    profile: 'desktop',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    uninstall: false,
    dryRun: false,
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
        options.dshHome = valueOf('--dsh-home')
        break
      case '--uninstall':
        options.uninstall = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        console.log(
          'Usage: node scripts/install-profile.mjs [--profile desktop] [--dsh-home <dir>] [--uninstall] [--dry-run]\n'
          + '\n'
          + 'Links the built @yankeguo/dsh-* workspace packages into the profile’s node_modules and\n'
          + 'adds @yankeguo/dsh-devlead-bundle to dsh.profile.bundles. Run "pnpm build" first.\n'
          + '--dry-run plans and validates the change without writing anything.',
        )
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

/** Resolve every workspace package directory with its manifest. */
async function readPackages() {
  const base = join(ROOT, 'packages')
  const entries = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(base, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    entries.push({ dir, manifest })
  }
  return entries.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

/**
 * Every built artifact a package must have before a profile link is usable:
 * each `exports`/`main` target the package declares, plus, for a bundle, every
 * file its `dsh.bundle.patch` and `icon` reference.
 * @param entry - one workspace package entry from {@link readPackages}.
 * @returns the missing files (package-relative), empty when complete.
 */
function missingBuildArtifacts(entry) {
  const manifest = entry.manifest
  const missing = []
  const targets = new Set()
  if (typeof manifest.main === 'string') targets.add(manifest.main)
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') targets.add(value)
    else if (value !== null && typeof value === 'object') {
      for (const target of Object.values(value)) if (typeof target === 'string') targets.add(target)
    }
  }
  for (const target of targets) {
    if (!target.startsWith('./lib/')) continue
    const relative = target.slice(2)
    if (!existsSync(join(entry.dir, relative))) missing.push(relative)
  }
  const bundle = manifest.dsh?.bundle
  if (bundle !== undefined) {
    const patch = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
    if (!Array.isArray(patch) || patch.length === 0 || !patch.every(file => typeof file === 'string')) {
      missing.push('dsh.bundle.patch (must be a file path or a list of file paths)')
    } else {
      for (const file of patch) if (!existsSync(join(entry.dir, file))) missing.push(file)
    }
    if (typeof manifest.icon === 'string' && !existsSync(join(entry.dir, manifest.icon))) {
      missing.push(manifest.icon)
    }
  }
  return missing
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

/** Keep one timestamped backup before rewriting a file. */
function backup(path) {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const target = `${path}.bak-devlead-${stamp}`
  copyFileSync(path, target)
  console.log(`backed up ${path} -> ${target}`)
}

/**
 * Write a JSON file only when its canonical form changed, backing up first.
 * @param path - file to rewrite.
 * @param manifest - parsed manifest value.
 * @returns whether the file was written.
 */
function writeManifestIfChanged(path, manifest) {
  const next = `${JSON.stringify(manifest, null, 2)}\n`
  if (readFileSync(path, 'utf8') === next) return false
  backup(path)
  writeFileSync(path, next)
  return true
}

/**
 * Classify one package's prospective link without touching the filesystem.
 * @param scopedDir - the profile's `node_modules/@yankeguo` directory.
 * @param entry - one workspace package entry from {@link readPackages}.
 * @returns action plus the message to print.
 */
function planLink(scopedDir, entry) {
  const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
  if (isSymlink(linkPath)) {
    const current = resolve(dirname(linkPath), readlinkSync(linkPath))
    if (current === entry.dir) return { action: 'same', linkPath }
    return { action: 'relink', linkPath }
  }
  if (existsSync(linkPath)) {
    const installedManifest = join(linkPath, 'package.json')
    if (existsSync(installedManifest)) {
      const installed = JSON.parse(readFileSync(installedManifest, 'utf8'))
      if (installed.name === entry.manifest.name) {
        return { action: 'keep-installed', linkPath, version: installed.version ?? 'unknown' }
      }
    }
    return { action: 'conflict', linkPath }
  }
  return { action: 'link', linkPath }
}

/**
 * Read and validate the target profile manifest.
 * @param profileDir - profile directory.
 * @returns the parsed manifest and its current bundle list.
 */
function readProfile(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`profile not found at ${profileDir} (set --dsh-home/--profile)`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must hold a JSON object`)
  }
  const dsh = manifest.dsh
  if (dsh !== undefined && (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh))) {
    throw new Error(`${manifestPath} has a non-object dsh field; refusing to rewrite it`)
  }
  const profile = dsh?.profile
  if (profile !== undefined && (profile === null || typeof profile !== 'object' || Array.isArray(profile))) {
    throw new Error(`${manifestPath} has a non-object dsh.profile field; refusing to rewrite it`)
  }
  const bundles = profile?.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    throw new Error(`${manifestPath} has a non-array dsh.profile.bundles; refusing to rewrite it`)
  }
  return { manifest, manifestPath, bundles: Array.isArray(bundles) ? bundles : [] }
}

/** Install (or remove) the profile links and bundle selection. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const { manifest, manifestPath, bundles } = readProfile(profileDir)
  const packages = await readPackages()
  const mainBundle = packages.find(entry => entry.manifest.name === MAIN_BUNDLE)
  if (mainBundle === undefined) throw new Error(`workspace package ${MAIN_BUNDLE} not found`)
  const missingBuild = packages.flatMap(entry => missingBuildArtifacts(entry).map(file => `${entry.manifest.name} (${file})`))
  if (missingBuild.length > 0) {
    throw new Error(`run "pnpm build" first; missing: ${missingBuild.join(', ')}`)
  }

  const scopedDir = join(profileDir, 'node_modules', '@yankeguo')
  const plans = packages.map(entry => ({ entry, ...planLink(scopedDir, entry) }))
  const conflicts = plans.filter(plan => plan.action === 'conflict')
  if (conflicts.length > 0) {
    throw new Error(
      `refusing to replace non-symlink paths: ${conflicts.map(plan => plan.linkPath).join(', ')}\n`
      + 'remove them manually and rerun',
    )
  }
  const kept = plans.filter(plan => plan.action === 'keep-installed')

  if (options.uninstall) {
    const hasBundle = bundles.includes(MAIN_BUNDLE)
    const linked = plans.filter(plan => plan.action === 'same' || plan.action === 'relink')
    const installedCopy = plans.some(plan => plan.action === 'keep-installed')
      || Object.hasOwn(manifest.dependencies ?? {}, MAIN_BUNDLE)
    const installedNote = installedCopy
      ? `note: ${MAIN_BUNDLE} is also installed in the profile; remove it with "dsh plugin --profile ${options.profile} remove ${MAIN_BUNDLE}" if desired`
      : undefined
    if (!hasBundle && linked.length === 0) {
      console.log(`nothing to uninstall from profile ${options.profile}`)
      if (installedNote !== undefined) console.log(installedNote)
      return
    }
    const prefix = options.dryRun ? '[dry-run] ' : ''
    if (options.dryRun) {
      console.log(`${prefix}would remove bundle selection ${MAIN_BUNDLE}`)
      for (const plan of linked) console.log(`${prefix}would remove link ${plan.linkPath}`)
      if (installedNote !== undefined) console.log(`${prefix}${installedNote}`)
      return
    }
    // Drop the selection first: the profile keeps booting even if a link
    // removal fails afterwards.
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = bundles.filter(name => name !== MAIN_BUNDLE)
    writeManifestIfChanged(manifestPath, manifest)
    let failures = 0
    for (const plan of linked) {
      try {
        unlinkSync(plan.linkPath)
        console.log(`removed link ${plan.linkPath}`)
      } catch (error) {
        failures += 1
        console.error(`failed to remove ${plan.linkPath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      rmdirSync(scopedDir)
    } catch {
      // Not empty (installed packages remain) or already gone: nothing to do.
    }
    if (failures > 0) process.exitCode = 1
    console.log(`uninstalled ${MAIN_BUNDLE} from profile ${options.profile}`)
    if (installedNote !== undefined) console.log(installedNote)
    return
  }

  const prefix = options.dryRun ? '[dry-run] ' : ''
  const alreadyEnabled = bundles.includes(MAIN_BUNDLE)
  const nextBundles = alreadyEnabled ? bundles : [...bundles, MAIN_BUNDLE]
  const changes = []
  if (!alreadyEnabled) changes.push(`enable ${MAIN_BUNDLE}`)
  const pending = plans.filter(plan => plan.action === 'link' || plan.action === 'relink')
  if (pending.length > 0) changes.push(`link ${pending.length} package${pending.length === 1 ? '' : 's'}`)

  if (options.dryRun) {
    console.log(`${prefix}profile ${profileDir}`)
    for (const plan of pending) console.log(`${prefix}would link ${plan.linkPath} -> ${plan.entry.dir}`)
    for (const plan of kept) {
      console.log(`${prefix}kept installed ${plan.entry.manifest.name} (${plan.version}); checkout copy not linked`)
    }
    for (const change of changes) console.log(`${prefix}would ${change}`)
    if (changes.length === 0) console.log(`${prefix}nothing to do`)
    return
  }

  if (pending.length > 0) {
    await mkdir(scopedDir, { recursive: true })
    for (const plan of pending) {
      if (isSymlink(plan.linkPath)) unlinkSync(plan.linkPath)
      symlinkSync(plan.entry.dir, plan.linkPath, 'dir')
      console.log(`linked ${plan.entry.manifest.name} -> ${plan.entry.dir}`)
    }
  }
  for (const plan of kept) {
    console.log(`kept installed package ${plan.entry.manifest.name} (${plan.version}); checkout copy not linked`)
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = nextBundles
  const written = writeManifestIfChanged(manifestPath, manifest)

  if (changes.length === 0 && !written) {
    console.log(`profile ${options.profile} is already up to date`)
  } else {
    console.log(`profile ${options.profile} updated${alreadyEnabled ? '' : ` (enabled ${MAIN_BUNDLE})`}`)
    console.log('Host plugins reload through profile HMR; reload the Web page for the browser half.')
    console.log('Try `/devlead on` in a conversation, or flip the DevLead switch above the composer.')
  }
}

try {
  await main()
} catch (error) {
  console.error(`install-profile: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
