#!/usr/bin/env node
/**
 * Stage every publishable workspace package for a release with
 * `npm stage publish`, consuming pnpm-packed tarballs.
 *
 * Why staged publishing: CI uploads each version to the npm registry but
 * publishes nothing. A maintainer later approves the staged versions with
 * scripts/promote-release.mjs (human 2FA). This makes a release "all or
 * nothing": either every package of the version is approved, or none is
 * public, and a broken tarball is never visible to users.
 *
 * Why pnpm pack: `npm pack`/`npm publish` from a package directory do not
 * understand the `workspace:` protocol; `pnpm pack` rewrites it to the exact
 * workspace version. This script therefore packs with pnpm and then stages
 * with the npm CLI (npm is the CLI that implements staged publishing,
 * OIDC trusted publishing, and provenance). For that reason it must run in
 * CI with `permissions: id-token: write`; locally the npm CLI needs
 * `npm login` (and OIDC/provenance are off).
 *
 * Guarantees:
 *   - validates that --version (or the root version) matches every package,
 *   - packs packages in workspace-dependency topological order,
 *   - asserts each packed manifest has the expected version and no
 *     "workspace:" protocol left,
 *   - stops at the first failure, prints what was staged so far and how to
 *     repair,
 *   - writes a stage-id table to stdout and, when GITHUB_STEP_SUMMARY is set,
 *     to the GitHub Actions job summary,
 *   - leaves the repository untouched (tarballs go to a system temp dir that
 *     is removed afterwards).
 *
 * Usage:
 *   node scripts/stage-release.mjs [options]
 *
 * Options:
 *   --version <x.y.z>   Expected version (default: root package.json version).
 *   --dist-tag <tag>    npm dist-tag for the staged versions (default: latest).
 *   --dry-run           Pack and validate the tarballs through the npm CLI
 *                       (`npm stage publish --dry-run --force`): uploads
 *                       nothing and creates no stage ids. --force disables
 *                       npm's registry "already published" guard, so the
 *                       preflight also works for a version that already
 *                       exists; it does not verify registry state.
 *   --no-provenance     Do not pass --provenance to npm (which is otherwise
 *                       only passed inside GitHub Actions).
 *   -h, --help          Show this help.
 *
 * Requires: node >= 24.9, pnpm (12.16.1 in CI), npm >= 11.15.0 (`npm stage`;
 * the CI workflow pins 11.20.0), tar (GNU tar on GitHub-hosted Ubuntu, bsdtar on macOS).
 *
 * Exit codes: 0 staged (or dry-run OK), 1 staging/validation failure,
 * 2 invalid invocation.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const ACCESS = 'public'
const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
/** npm dist-tags must not look like a semver version and must be argv-safe. */
const DIST_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u

class UsageError extends Error {}
class StageError extends Error {}

const usage = `Stage every publishable workspace package for a release with npm staged publishing.

Usage: node scripts/stage-release.mjs [options]

Options:
  --version <x.y.z>   Expected version. Default: the root package.json version.
                      The root and every publishable package must match it.
  --dist-tag <tag>    npm dist-tag recorded with each staged version.
                      Default: latest. Must not look like a version.
  --dry-run           Pack everything and validate the tarballs through the
                      npm CLI ('npm stage publish --dry-run --force'): uploads
                      nothing, creates no stage ids. --force skips npm's
                      registry "already published" check, so this does not
                      validate registry state.
  --no-provenance     Do not pass --provenance even inside GitHub Actions.
  -h, --help          Show this help.

Environment:
  GITHUB_ACTIONS=true        Adds --provenance (npm also auto-enables it for
                             public packages from a public repository when the
                             OIDC token exchange succeeds).
  GITHUB_STEP_SUMMARY=<path> Appends the staged-version table to the job summary.

This script never publishes: it only stages. Approve with
'node scripts/promote-release.mjs' locally (npm login + 2FA).
`

/**
 * Parse process.argv into options, rejecting unknown/incomplete flags with
 * exit code 2.
 * @param {string[]} argv
 * @returns {{version: string | null, distTag: string, dryRun: boolean, noProvenance: boolean}}
 */
function parseArgs (argv) {
  const options = { version: null, distTag: 'latest', dryRun: false, noProvenance: false }
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    // Tolerate the conventional end-of-options marker so `pnpm release:* -- --flag`
    // and `npm run release:* -- --flag` work; this CLI takes no positional args.
    if (raw === '--') continue
    const [flag, inlineValue] = raw.startsWith('--') && raw.includes('=')
      ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
      : [raw, undefined]
    const value = inlineValue ?? argv[index + 1]
    const takeValue = (name) => {
      if (typeof value !== 'string' || value === '' || (!inlineValue && value.startsWith('--'))) {
        throw new UsageError(`${name} needs a value`)
      }
      if (inlineValue === undefined) index++
      return value
    }
    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(usage)
        process.exit(0)
        break
      case '--version':
        options.version = takeValue('--version')
        if (!VERSION_PATTERN.test(options.version)) throw new UsageError(`--version must be a semver version such as 0.2.0 (got ${options.version})`)
        break
      case '--dist-tag':
        options.distTag = takeValue('--dist-tag')
        if (!DIST_TAG_PATTERN.test(options.distTag)) throw new UsageError(`--dist-tag must match ${DIST_TAG_PATTERN} and not look like a version (got ${options.distTag})`)
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--no-provenance':
        options.noProvenance = true
        break
      default:
        throw new UsageError(`unknown argument: ${raw}`)
    }
  }
  return options
}

/**
 * Read and parse a JSON file with a contextual error message.
 * @param {string} filePath
 * @returns {any}
 */
function readJson (filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new StageError(`cannot read ${filePath}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new StageError(`${filePath} is not valid JSON: ${error.message}`)
  }
}

/**
 * Discover publishable workspace packages (directories under packages/ with a
 * non-private manifest and a name).
 * @returns {Array<{name: string, version: string, dir: string, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, peerDependencies: Record<string, string>, devDependencies: Record<string, string>}>}
 */
function discoverPackages () {
  const packages = []
  for (const dirName of readdirSync(PACKAGES_DIR).sort()) {
    const dir = join(PACKAGES_DIR, dirName)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (manifest.private === true) continue
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new StageError(`${manifestPath}: publishable package must have a non-empty "name"`)
    }
    packages.push({
      name: manifest.name,
      version: String(manifest.version ?? ''),
      dir,
      dependencies: manifest.dependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
    })
  }
  if (packages.length === 0) throw new StageError(`no publishable packages found under ${PACKAGES_DIR}`)
  return packages
}

/**
 * Return the workspace packages a package depends on at runtime, as names.
 * @param {{name: string, dependencies: Record<string, string>, optionalDependencies: Record<string, string>}} pkg
 * @param {Set<string>} workspaceNames
 * @returns {string[]}
 */
function runtimeWorkspaceDependencies (pkg, workspaceNames) {
  return [...new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.optionalDependencies)])]
    .filter(name => workspaceNames.has(name))
    .sort()
}

/**
 * Sort packages so workspace dependencies come before their dependents.
 * Deterministic: ready packages are always emitted in name order.
 * @param {ReturnType<typeof discoverPackages>} packages
 * @returns {ReturnType<typeof discoverPackages>}
 */
function sortByWorkspaceDependencies (packages) {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const workspaceNames = new Set(byName.keys())
  /** @type {Map<string, string[]>} name -> dependents */
  const dependents = new Map(packages.map(pkg => [pkg.name, []]))
  /** @type {Map<string, number>} name -> number of workspace deps */
  const indegree = new Map(packages.map(pkg => [pkg.name, 0]))
  for (const pkg of packages) {
    const deps = runtimeWorkspaceDependencies(pkg, workspaceNames)
    indegree.set(pkg.name, deps.length)
    for (const dep of deps) dependents.get(dep).push(pkg.name)
  }
  for (const names of dependents.values()) names.sort()
  const ready = packages.filter(pkg => indegree.get(pkg.name) === 0).map(pkg => pkg.name).sort()
  const ordered = []
  while (ready.length > 0) {
    const name = ready.shift()
    ordered.push(byName.get(name))
    for (const dependent of dependents.get(name)) {
      indegree.set(dependent, indegree.get(dependent) - 1)
      if (indegree.get(dependent) === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  if (ordered.length !== packages.length) {
    const cyclic = packages.map(pkg => pkg.name).filter(name => !ordered.some(pkg => pkg.name === name))
    throw new StageError(`circular workspace dependency between packages: ${cyclic.join(', ')}`)
  }
  return ordered
}

/**
 * Run one command, returning its exit status, stdout and stderr instead of
 * throwing, so callers can attach actionable context.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string}} options
 * @returns {{status: number | null, stdout: string, stderr: string, error?: Error}}
 */
function run (command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

/**
 * Assert a command exists (spawn failed with ENOENT) and produce a friendly
 * install hint instead of a stack trace.
 * @param {{status: number | null, error?: Error}} result
 * @param {string} command
 */
function assertSpawned (result, command) {
  if (result.error?.code === 'ENOENT') {
    throw new StageError(`'${command}' was not found on PATH; install it before staging`)
  }
  if (result.error) throw new StageError(`failed to run '${command}': ${result.error.message}`)
}

/**
 * Best-effort short tail of a command's output for error messages.
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail (text, lines = 12) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

/**
 * Pack one package with pnpm (which rewrites workspace: dependencies) into the
 * tarball directory.
 * @param {{name: string, version: string, dir: string}} pkg
 * @param {string} packDir
 * @returns {string} absolute tarball path
 */
function packPackage (pkg, packDir) {
  const result = run('pnpm', ['pack', '--pack-destination', packDir, '--json'], { cwd: pkg.dir })
  assertSpawned(result, 'pnpm')
  if (result.status !== 0) {
    throw new StageError(
      `pnpm pack failed for ${pkg.name} (exit ${result.status})\n${tail(result.stderr || result.stdout)}`
    )
  }
  let packed
  try {
    packed = JSON.parse(result.stdout)
  } catch {
    throw new StageError(`pnpm pack --json for ${pkg.name} did not print JSON:\n${tail(result.stdout)}`)
  }
  if (packed.name !== pkg.name) throw new StageError(`pnpm pack for ${pkg.name} packed unexpected package ${packed.name}`)
  if (packed.version !== pkg.version) throw new StageError(`pnpm pack for ${pkg.name} reported version ${packed.version}, expected ${pkg.version}`)
  const tarball = isAbsolute(packed.filename) ? packed.filename : resolve(pkg.dir, packed.filename)
  if (!existsSync(tarball)) throw new StageError(`pnpm pack for ${pkg.name} did not create ${tarball}`)
  return tarball
}

/**
 * Read package/package.json out of a packed tarball. Node has no tar parser in
 * its standard library, so this shells out to the system tar explicitly with an
 * argument array (no shell, no user-controlled interpolation).
 * @param {string} tarball
 * @returns {string} raw manifest text
 */
function readPackedManifestText (tarball) {
  const result = run('tar', ['-xzOf', tarball, 'package/package.json'], { cwd: dirname(tarball) })
  assertSpawned(result, 'tar')
  if (result.status !== 0) {
    throw new StageError(`cannot read package/package.json from ${tarball} (exit ${result.status}); GNU tar or bsdtar is required\n${tail(result.stderr)}`)
  }
  return result.stdout
}

/**
 * Assert the packed tarball is what the release tag promises: expected
 * version, workspace protocol rewritten by pnpm, and intra-workspace
 * dependency versions exactly equal to the release version.
 *
 * Locale wiring (the client UI locale/*.json files) is NOT asserted here on
 * purpose: the build and scripts/check-packages.mjs already fail loudly when
 * locale metadata and dictionaries drift, and duplicating that rule in the
 * staging path would make a release fail for a reason that is not about
 * staging.
 *
 * @param {{name: string, version: string}} pkg
 * @param {string} tarball
 * @param {string} expectedVersion
 * @param {Set<string>} workspaceNames
 */
function assertPackedTarball (pkg, tarball, expectedVersion, workspaceNames) {
  const text = readPackedManifestText(tarball)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new StageError(`packed manifest of ${pkg.name} is not valid JSON`)
  }
  if (manifest.name !== pkg.name) throw new StageError(`packed manifest of ${pkg.name} is named ${manifest.name}`)
  if (manifest.version !== expectedVersion) {
    throw new StageError(`packed ${pkg.name} has version ${manifest.version}, expected ${expectedVersion}; bump all workspace manifests together before staging`)
  }
  if (text.includes('workspace:')) {
    throw new StageError(
      `packed ${pkg.name} still contains "workspace:" dependency specs.\n` +
      'pnpm pack rewrites the workspace: protocol to exact versions; npm pack does not. ' +
      'Do not replace the pnpm pack step with npm pack/npm publish from the package directory.'
    )
  }
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
  for (const section of sections) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (!workspaceNames.has(name)) continue
      if (range !== expectedVersion) {
        throw new StageError(
          `packed ${pkg.name} depends on workspace package ${name}@${range}, expected exact version ${expectedVersion}; ` +
          'a release must ship one version of every workspace package'
        )
      }
    }
  }
}

/**
 * Stage one packed tarball with the npm CLI and return its stage id.
 * @param {{name: string, version: string}} pkg
 * @param {string} tarball
 * @param {{distTag: string, dryRun: boolean, provenance: boolean}} options
 * @param {string} neutralDir directory with no repo .npmrc, so npm does not warn about pnpm-only keys
 * @returns {{stageId: string | null, fileCount: number}}
 */
function stagePackage (pkg, tarball, options, neutralDir) {
  const args = ['stage', 'publish', tarball, '--access', ACCESS, '--tag', options.distTag, '--json']
  if (options.dryRun) {
    // --dry-run alone still performs the registry "already published" check, so
    // a version that was already staged/published would fail the local
    // preflight. --force suppresses that check; it is only used in dry-run.
    args.push('--dry-run', '--force')
  } else if (options.provenance) {
    args.push('--provenance')
  }
  const result = run('npm', args, { cwd: neutralDir })
  assertSpawned(result, 'npm')
  const stdout = result.stdout.trim()
  let parsed = null
  try {
    parsed = stdout === '' ? null : JSON.parse(stdout)
  } catch {
    parsed = null
  }
  if (parsed && Object.hasOwn(parsed, 'error')) {
    const { code, summary, detail } = parsed.error ?? {}
    throw new StageError(
      `npm stage publish failed for ${pkg.name}: ${code ? `${code}: ` : ''}${summary ?? 'unknown error'}${detail ? `\n${detail}` : ''}` +
      (code === 'ENEEDAUTH' ? '\nNot logged in (or the CI OIDC exchange failed). Locally run npm login; in CI check id-token: write and the trusted publisher record (--allow-stage-publish).' : '')
    )
  }
  if (result.status !== 0) {
    throw new StageError(
      `npm stage publish failed for ${pkg.name} (exit ${result.status})\n${tail(result.stderr || result.stdout)}`
    )
  }
  if (parsed === null) {
    throw new StageError(`npm stage publish for ${pkg.name} did not print JSON; output:\n${tail(result.stdout || result.stderr)}`)
  }
  const entry = parsed[pkg.name]
  if (!entry || typeof entry !== 'object') {
    throw new StageError(`npm stage publish for ${pkg.name} printed JSON without a "${pkg.name}" entry:\n${tail(stdout)}`)
  }
  if (entry.version !== pkg.version) {
    throw new StageError(`npm stage publish for ${pkg.name} reported version ${entry.version}, expected ${pkg.version}`)
  }
  const fileCount = Array.isArray(entry.files) ? entry.files.length : 0
  if (options.dryRun) {
    return { stageId: null, fileCount }
  }
  if (typeof entry.stageId !== 'string' || !STAGE_ID_PATTERN.test(entry.stageId)) {
    throw new StageError(
      `npm stage publish for ${pkg.name} did not return a UUID stage id (got ${JSON.stringify(entry.stageId)}). ` +
      'Staged publishing requires npm >= 11.15.0; in CI the workflow pins npm 11.20.0.'
    )
  }
  return { stageId: entry.stageId, fileCount }
}

/**
 * Append a Markdown table of staged versions to the GitHub Actions job
 * summary when the runner provides one.
 * @param {string} markdown
 */
function appendStepSummary (markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  try {
    appendFileSync(summaryPath, markdown)
  } catch (error) {
    console.warn(`warning: could not append to GITHUB_STEP_SUMMARY (${summaryPath}): ${error.message}`)
  }
}

/**
 * Print the staged-so-far table and the repair hints after the first failure.
 * @param {string} version release version, or '(unknown)' when not resolved yet
 * @param {Array<{name: string, version: string, stageId: string}>} staged
 * @param {StageError} error
 */
function reportFailure (version, staged, error) {
  console.error('')
  console.error(`stage-release failed: ${error.message}`)
  console.error('')
  if (staged.length > 0) {
    console.error(`${staged.length} package(s) were staged before the failure; nothing is public yet:`)
    for (const item of staged) console.error(`  - ${item.name}@${item.version}  stageId=${item.stageId}`)
    console.error('')
  } else {
    console.error('No package was staged by this run.')
    console.error('')
  }
  if (staged.length > 0) {
    appendStepSummary(
      `## npm staged publish — ${version} (FAILED)\n\n` +
      `${staged.length} package(s) were staged before the failure; nothing is public.\n\n` +
      '| package | version | stage id |\n| --- | --- | --- |\n' +
      staged.map(item => `| \`${item.name}\` | ${item.version} | \`${item.stageId}\` |`).join('\n') + '\n'
    )
  }
  console.error('Repair hints:')
  console.error('  - inspect the registry state:  npm stage list <package> --json')
  console.error('  - inspect an existing stage:   npm stage view <stage-id> --json')
  console.error('  - reject a stale/duplicate stage id (irreversible, removes the staged tarball):')
  console.error('      npm stage reject <stage-id>')
  console.error('  - if the version is already fully staged, do NOT re-run staging; approve it with')
  console.error(`      node scripts/promote-release.mjs --version ${version}`)
  console.error('  - to retry CI after a fix, re-run the publish workflow with workflow_dispatch and')
  console.error('    the SAME existing release_tag (never move or recreate the tag).')
  console.error('  - a version that is already published cannot be staged again: bump every workspace')
  console.error('    package together and push a new tag instead.')
}

/**
 * Entry point.
 * @returns {number} process exit code
 */
function main () {
  /** @type {{version: string | null, distTag: string, dryRun: boolean, noProvenance: boolean}} */
  let options = { version: null, distTag: 'latest', dryRun: false, noProvenance: false }
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`stage-release: ${error.message}\nRun with --help for usage.`)
      return 2
    }
    throw error
  }
  /** @type {Array<{name: string, version: string, stageId: string}>} */
  const staged = []
  /** @type {string} release version once resolved, for failure reports */
  let resolvedVersion = options.version ?? '(unknown)'
  /** @type {string | null} */
  let workDir = null
  try {
    const rootManifest = readJson(join(ROOT, 'package.json'))
    const expectedVersion = options.version ?? String(rootManifest.version ?? '')
    resolvedVersion = expectedVersion
    if (!VERSION_PATTERN.test(expectedVersion)) {
      throw new StageError(`cannot determine a valid release version (root package.json version is ${JSON.stringify(rootManifest.version)})`)
    }
    if (rootManifest.version !== expectedVersion) {
      throw new StageError(`root package.json is version ${rootManifest.version}, but --version says ${expectedVersion}; bump the root and all packages together`)
    }
    const packages = sortByWorkspaceDependencies(discoverPackages())
    const mismatched = packages.filter(pkg => pkg.version !== expectedVersion)
    if (mismatched.length > 0) {
      throw new StageError(
        `release version is ${expectedVersion}, but these packages disagree: ${mismatched.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}. ` +
        'All workspace packages must share one version for a release.'
      )
    }

    // A neutral working directory keeps npm from reading this repository's
    // pnpm-only .npmrc (node-linker/auto-install-peers), which npm would report
    // as unknown project config.
    workDir = mkdtempSync(join(tmpdir(), 'dsh-devlead-stage-'))
    const neutralDir = workDir
    const packDir = join(workDir, 'packs')
    mkdirSync(packDir)

    const npmStage = run('npm', ['stage', '--help'], { cwd: neutralDir })
    assertSpawned(npmStage, 'npm')
    if (npmStage.status !== 0) {
      throw new StageError(
        `this npm does not implement staged publishing (npm stage --help failed). npm >= 11.15.0 is required; install it with: npm install -g npm@11.20.0 (CI pins npm 11.20.0)`
      )
    }
    const pnpmVersion = run('pnpm', ['--version'], { cwd: ROOT })
    assertSpawned(pnpmVersion, 'pnpm')
    if (pnpmVersion.status !== 0) throw new StageError('pnpm is required to pack workspace packages; install pnpm 12.16.1 (`corepack enable`)')

    const provenance = process.env.GITHUB_ACTIONS === 'true' && !options.noProvenance
    const mode = options.dryRun ? 'DRY RUN (no upload)' : 'STAGE'
    console.log(`stage-release: ${mode} — version ${expectedVersion}, dist-tag ${options.distTag}`)
    console.log(`npm ${(run('npm', ['--version'], { cwd: neutralDir }).stdout || '').trim()} / pnpm ${pnpmVersion.stdout.trim()}`)
    console.log(`provenance: ${provenance ? 'yes (--provenance, GitHub Actions)' : 'no'}`)
    console.log('')
    console.log(`Packing and staging ${packages.length} packages in workspace-dependency order:`)
    for (const [index, pkg] of packages.entries()) {
      console.log(`${index + 1}. ${pkg.name}@${pkg.version}`)
    }
    console.log('')

    const workspaceNames = new Set(packages.map(pkg => pkg.name))
    for (const [index, pkg] of packages.entries()) {
      const tarball = packPackage(pkg, packDir)
      assertPackedTarball(pkg, tarball, expectedVersion, workspaceNames)
      const result = stagePackage(pkg, tarball, {
        distTag: options.distTag,
        dryRun: options.dryRun,
        provenance,
      }, neutralDir)
      if (options.dryRun) {
        console.log(`[${index + 1}/${packages.length}] dry-run OK ${pkg.name}@${pkg.version} (${result.fileCount} files, ${tarball.split('/').pop()})`)
      } else {
        staged.push({ name: pkg.name, version: pkg.version, stageId: result.stageId })
        console.log(`[${index + 1}/${packages.length}] staged ${pkg.name}@${pkg.version} stageId=${result.stageId}`)
      }
    }

    console.log('')
    if (options.dryRun) {
      console.log(`DRY RUN OK: packed and preflighted ${packages.length} packages; nothing was uploaded and no stage id was created.`)
      appendStepSummary(`## npm staged publish — ${expectedVersion} (dry run)\n\nDry run: packed and preflighted ${packages.length} packages, nothing was uploaded.\n`)
      return 0
    }
    console.log(`STAGED ${staged.length}/${packages.length} packages for ${expectedVersion}. NOTHING IS PUBLIC YET.`)
    console.log('')
    console.log('Next step (human, npm login + 2FA):')
    console.log(`  node scripts/promote-release.mjs --version ${expectedVersion}`)
    console.log('That command verifies every staged id, approves them in order (npm prompts for the OTP),')
    console.log('then creates or updates the GitHub Release.')
    const rows = staged.map(item => `| \`${item.name}\` | ${item.version} | \`${item.stageId}\` |`).join('\n')
    appendStepSummary(
      `## npm staged publish — ${expectedVersion}\n\n` +
      `${staged.length}/${packages.length} packages staged. Nothing is public until a maintainer approves.\n\n` +
      '| package | version | stage id |\n| --- | --- | --- |\n' + rows + '\n'
    )
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`stage-release: ${error.message}\nRun with --help for usage.`)
      return 2
    }
    if (error instanceof StageError) {
      reportFailure(resolvedVersion, staged, error)
      return 1
    }
    reportFailure(resolvedVersion, staged, new StageError(error?.stack ?? String(error)))
    return 1
  } finally {
    if (workDir !== null) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`warning: could not remove temporary directory ${workDir}: ${error.message}`)
      }
    }
  }
}

process.exitCode = main()
