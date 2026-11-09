#!/usr/bin/env node
/**
 * Link the built devlead plugin suite into a DSH profile.
 *
 * This is the self-install path for a local checkout:
 *   - symlinks every `@yankeguo/dsh-*` workspace package into
 *     `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`;
 *   - appends the bundle package to the profile's `dsh.profile.bundles`.
 *
 * The write is idempotent: the profile manifest is only rewritten (and only
 * backed up) when its content actually changes, so repeated runs leave no
 * backup clutter. `--uninstall` reverses both the links and the bundle
 * selection.
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
        console.log('Usage: node scripts/install-profile.mjs [--profile desktop] [--dsh-home <dir>] [--uninstall] [--dry-run]')
        process.exit(0)
      // fallthrough for unknown flags
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  options.dshHome = resolve(options.dshHome)
  if (options.profile.trim().length === 0) throw new Error('--profile must not be empty')
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
 * Every built artifact a package must have before a profile link is usable.
 * @param entry - one workspace package entry from {@link readPackages}.
 * @returns the missing built files (package-relative), empty when complete.
 */
function missingBuildArtifacts(entry) {
  const manifest = entry.manifest
  if (manifest.dsh?.bundle !== undefined) return []
  const missing = []
  if (!existsSync(join(entry.dir, 'lib', 'index.js'))) missing.push('lib/index.js')
  if (manifest.dsh?.client !== undefined && !existsSync(join(entry.dir, 'lib', 'client.js'))) {
    missing.push('lib/client.js')
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

/** Install (or remove) the profile links and bundle selection. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`profile "${options.profile}" not found at ${profileDir} (set --dsh-home/--profile)`)
  }
  const packages = await readPackages()
  const mainBundle = packages.find(entry => entry.manifest.name === MAIN_BUNDLE)
  if (mainBundle === undefined) throw new Error(`workspace package ${MAIN_BUNDLE} not found`)
  const missingBuild = packages.flatMap(entry => missingBuildArtifacts(entry).map(file => `${entry.manifest.name} (${file})`))
  if (missingBuild.length > 0) {
    throw new Error(`run "pnpm build" first; missing: ${missingBuild.join(', ')}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  if (manifest.dsh.profile.bundles !== undefined && !Array.isArray(manifest.dsh.profile.bundles)) {
    throw new Error(`profile ${manifestPath} has a non-array dsh.profile.bundles; refusing to rewrite it`)
  }
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
  const scopedDir = join(profileDir, 'node_modules', '@yankeguo')

  if (options.uninstall) {
    const next = bundles.filter(name => name !== MAIN_BUNDLE)
    if (!options.dryRun) {
      for (const entry of packages) {
        const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
        if (isSymlink(linkPath)) unlinkSync(linkPath)
      }
      manifest.dsh.profile.bundles = next
      writeManifestIfChanged(manifestPath, manifest)
    }
    console.log(`${options.dryRun ? '[dry-run] ' : ''}uninstalled ${MAIN_BUNDLE} from profile ${options.profile}`)
    return
  }

  if (!bundles.includes(MAIN_BUNDLE)) bundles.push(MAIN_BUNDLE)

  if (options.dryRun) {
    console.log(`[dry-run] would link ${packages.length} packages into ${scopedDir}`)
  } else {
    await mkdir(scopedDir, { recursive: true })
    for (const entry of packages) {
      const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
      if (isSymlink(linkPath)) {
        const target = resolve(dirname(linkPath), readlinkSync(linkPath))
        if (target === entry.dir) continue
        unlinkSync(linkPath)
      } else if (existsSync(linkPath)) {
        // A profile installed through the plugin manager owns real package
        // directories (pnpm layout). Leave an equivalent installed copy alone
        // and only link the packages this checkout adds.
        const installedManifest = join(linkPath, 'package.json')
        if (existsSync(installedManifest)) {
          const installed = JSON.parse(readFileSync(installedManifest, 'utf8'))
          if (installed.name === entry.manifest.name) {
            console.log(`kept installed package ${entry.manifest.name} (${installed.version ?? 'unknown'})`)
            continue
          }
        }
        throw new Error(`${linkPath} exists and is not a symlink; refusing to replace it`)
      }
      symlinkSync(entry.dir, linkPath, 'dir')
      console.log(`linked ${entry.manifest.name} -> ${entry.dir}`)
    }
    manifest.dsh.profile.bundles = bundles
    writeManifestIfChanged(manifestPath, manifest)
  }

  console.log(`${options.dryRun ? '[dry-run] ' : ''}enabled ${MAIN_BUNDLE} in profile ${options.profile}`)
  console.log('Host plugins reload through profile HMR; reload the Web page for the browser half.')
  console.log('Try `/devlead on` in a conversation, or flip the DevLead switch above the composer.')
}

try {
  await main()
} catch (error) {
  console.error(`install-profile: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
