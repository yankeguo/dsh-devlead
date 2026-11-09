#!/usr/bin/env node
/**
 * Validate the workspace packaging contract that the build itself cannot see:
 * version/engine lockstep, dependency placement (including no DSH direct or
 * optional dependencies and no experimental packages), peer completeness for
 * DSH linked-root resolution, browser/client-inject coverage, tsconfig/vitest
 * alias coverage, lockfile importers, and the pinned CI workflows.
 *
 * This is intentionally dependency-free and read-only; it is safe to run in CI
 * after `pnpm build` and is wired into both verify.yml and publish.yml. Run:
 *
 *   node scripts/check-packages.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_EXTERNALS as CLIENT_PLATFORM_MODULES } from './client-externals.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/** The browser module table (shared with the build and the check). */
const CLIENT_EXTERNALS = new Set(CLIENT_PLATFORM_MODULES)

/** Root devDependencies that no source file imports directly, with their role. */
const DEV_INFRA = {
  esbuild: 'scripts/build.mjs bundler',
  typescript: 'the typecheck script',
  '@types/node': 'tsconfig.base.json "types"',
  '@types/react': 'JSX attributes for the client sources',
}

/** Expected pinned toolchain used by every workflow. */
const PNPM_VERSION = '12.16.1'
const NODE_VERSION = '24'
const PINNED_ACTIONS = ['actions/checkout@', 'pnpm/action-setup@', 'actions/setup-node@']

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/check-packages.mjs\n\nRead-only workspace packaging checks: version/engine lockstep, dependency placement,\npeer completeness for DSH linked-root resolution, alias coverage, lockfile importers, and CI workflow pins.')
  process.exit(0)
}
if (argv.length > 0) {
  console.error(`check-packages: unknown argument: ${argv[0]}`)
  process.exit(2)
}

const failures = []
const notes = []

/**
 * Record one failure (or a note when accepted).
 * @param {string} message
 */
function fail(message) {
  failures.push(message)
}

/** Read and parse a JSON file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Recursively list TypeScript sources below a directory. */
function listSources(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'lib') files.push(...listSources(path))
    } else if (/\.(ts|tsx|mts)$/u.test(entry.name)) files.push(path)
  }
  return files
}

/**
 * Extract module specifiers imported by one file, with the import kind.
 * @param {string} file
 * @returns {{ specifier: string, typeOnly: boolean }[]}
 */
function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  const found = []
  const push = (specifier, typeOnly) => {
    if (specifier.startsWith('.') || specifier.startsWith('node:')) return
    found.push({ specifier, typeOnly })
  }
  // `import ... from 'x'` and `export ... from 'x'`, including multiline import
  // clauses. Semicolons end a clause, so an unrelated later statement is not
  // swallowed; `from` is required here so side-effect imports use their own
  // pattern below.
  const staticPattern = /(?:^|\n)[ \t]*(import|export)\s+(type\s+)?([^'"`;]*?)\bfrom\s+['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(staticPattern)) {
    const [, keyword, typeOnly, clause, specifier] = match
    // A non-re-export `export const x = ...` is not an import edge.
    if (keyword === 'export' && typeOnly === undefined && !clause.includes('{') && !clause.includes('*')) continue
    push(specifier, typeOnly !== undefined)
  }
  // Side-effect imports (`import 'x'`).
  const sideEffectPattern = /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(sideEffectPattern)) push(match[1], false)
  // Literal dynamic imports are runtime edges too.
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
  for (const match of source.matchAll(dynamicPattern)) push(match[1], false)
  return found
}

/** Package name of a bare specifier (`@scope/name` or `name`). */
function packageNameOf(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

/** Package subpath of a bare specifier (`.` when none). */
function subpathOf(specifier) {
  const rest = specifier.startsWith('@')
    ? specifier.split('/').slice(2).join('/')
    : specifier.split('/').slice(1).join('/')
  return rest.length === 0 ? '.' : `./${rest}`
}

// ---- manifests -------------------------------------------------------------
const rootManifest = readJson(join(ROOT, 'package.json'))
const manifests = []
for (const entry of readdirSync(PACKAGES, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory() || !existsSync(join(PACKAGES, entry.name, 'package.json'))) continue
  manifests.push({ dir: entry.name, dirPath: join(PACKAGES, entry.name), manifest: readJson(join(PACKAGES, entry.name, 'package.json')) })
}
if (manifests.length === 0) fail('no package manifests found under packages/')

if (rootManifest.private !== true) fail('root package.json must stay "private": true')
if (rootManifest.type !== 'module') fail('root package.json must be "type": "module"')
if (typeof rootManifest.engines?.node !== 'string') fail('root package.json must declare engines.node')

const versions = new Set(manifests.map(entry => entry.manifest.version))
if (versions.size !== 1) fail(`all publishable packages must share one version, found ${[...versions].join(', ')}`)
else if (rootManifest.version !== manifests[0]?.manifest.version) {
  fail(`root version ${rootManifest.version} must match the package version ${manifests[0]?.manifest.version}`)
}

const dshRanges = new Set(manifests.map(entry => entry.manifest.engines?.dsh))
if (dshRanges.size !== 1) fail(`all packages must declare the same engines.dsh, found ${[...dshRanges].join(', ')}`)
else if (typeof [...dshRanges][0] !== 'string' || [...dshRanges][0].trim().length === 0) {
  fail('every package must declare a non-empty engines.dsh range')
}

// Repository/homepage consistency comes from the first package.
const repositoryUrl = manifests[0]?.manifest.repository?.url
const homepage = manifests[0]?.manifest.homepage
if (typeof repositoryUrl !== 'string') fail(`${manifests[0]?.dir}: missing repository.url to compare against`)
for (const { dir, manifest } of manifests) {
  const label = `packages/${dir}`
  for (const field of ['name', 'version', 'description', 'license']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0) fail(`${label}: missing "${field}"`)
  }
  if (manifest.type !== 'module') fail(`${label}: must be "type": "module"`)
  if (manifest.private === true) fail(`${label}: publishable packages must not be "private"`)
  if (manifest.publishConfig?.access !== 'public') fail(`${label}: publishConfig.access must be "public"`)
  if (manifest.repository?.url !== repositoryUrl) fail(`${label}: repository.url must be ${repositoryUrl}`)
  if (manifest.repository?.directory !== label) fail(`${label}: repository.directory must be "${label}"`)
  if (manifest.homepage !== homepage) fail(`${label}: homepage must be ${homepage}`)
  if (!/^@yankeguo\//u.test(manifest.name ?? '')) fail(`${label}: package name must stay in the @yankeguo scope`)
}

/** Workspace manifest by package name. */
const workspaceByName = new Map(manifests.map(entry => [entry.manifest.name, entry]))

// ---- dependency placement --------------------------------------------------
for (const { dir, dirPath, manifest } of manifests) {
  const label = `packages/${dir}`
  const dependencies = manifest.dependencies ?? {}
  const peers = manifest.peerDependencies ?? {}
  const allDeclared = new Set([...Object.keys(dependencies), ...Object.keys(peers), ...Object.keys(manifest.optionalDependencies ?? {})])
  for (const [name, spec] of Object.entries(dependencies)) {
    if (name.startsWith('@yankeguo/') && spec !== 'workspace:*') {
      fail(`${label}: workspace dependency ${name} must use "workspace:*" (got ${JSON.stringify(spec)})`)
    }
  }
  for (const [name, spec] of Object.entries(peers)) {
    if (name.startsWith('@yankeguo/')) continue
    const rootSpec = rootManifest.devDependencies?.[name]
    if (rootSpec === undefined) {
      fail(`${label}: peer ${name} is not installed at the root for type checking; add it to devDependencies`)
    } else if (rootSpec !== spec) {
      fail(`${label}: peer ${name}@${spec} must match the root devDependency ${name}@${rootSpec}`)
    }
  }
  // Host runtime imports must be peers (linked-root routing), and no DSH
  // package may be declared as a direct/optional dependency: those edges install
  // a second physical copy and are only safe through peer resolution.
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@deepseek-ai/')) {
      fail(`${label}: DSH package ${name} must be a peerDependency, not a dependency`)
    }
    if (name.includes('dsh-experimental')) fail(`${label}: must not declare experimental package ${name}`)
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/')) fail(`${label}: DSH package ${name} must not be an optionalDependency`)
    if (name.includes('dsh-experimental')) fail(`${label}: must not declare experimental package ${name}`)
  }
  for (const name of Object.keys(peers)) {
    if (name.includes('dsh-experimental')) fail(`${label}: must not declare experimental package ${name}`)
  }
  // `dsh.client.inject` is informational to the loader, but a bogus or optional
  // client id is still a packaging mistake worth catching before release.
  const client = manifest.dsh?.client
  if (client !== undefined) {
    if (typeof client !== 'object' || client === null || Array.isArray(client)) {
      fail(`${label}: dsh.client must be an object`)
    } else {
      const injects = client.inject
      if (!Array.isArray(injects)) fail(`${label}: dsh.client.inject must be an array`)
      else {
        const seen = new Set()
        for (const id of injects) {
          if (typeof id !== 'string' || !id.startsWith('@deepseek-ai/')) {
            fail(`${label}: dsh.client.inject entry ${JSON.stringify(id)} must be a @deepseek-ai/* package name`)
            continue
          }
          if (id.includes('dsh-experimental')) fail(`${label}: dsh.client.inject must not reference ${id}`)
          if (seen.has(id)) fail(`${label}: dsh.client.inject lists ${id} twice`)
          seen.add(id)
          if (!Object.hasOwn(rootManifest.devDependencies ?? {}, id) && !CLIENT_EXTERNALS.has(id)) {
            fail(`${label}: dsh.client.inject entry ${id} is neither a root devDependency nor a platform singleton`)
          }
        }
      }
    }
  }
  // Every workspace import is declared, and subpath imports are exported.
  for (const file of [...listSources(join(dirPath, 'src')), ...listSources(join(dirPath, 'tests'))]) {
    for (const { specifier, typeOnly } of importsOf(file)) {
      const packageName = packageNameOf(specifier)
      const relative = file.slice(ROOT.length + 1)
      if (packageName.startsWith('@yankeguo/')) {
        // A test may consume its own package by name (self-reference); that is
        // not a dependency edge and resolves through the aliases below.
        if (packageName === manifest.name) continue
        if (!allDeclared.has(packageName)) {
          fail(`${relative}: imports ${specifier} but ${label} does not declare it`)
          continue
        }
        const workspace = workspaceByName.get(packageName)
        if (workspace === undefined) {
          fail(`${relative}: imports ${specifier} but no workspace package declares ${packageName}`)
          continue
        }
        const subpath = subpathOf(specifier)
        if (subpath !== '.' && workspace.manifest.exports?.[subpath] === undefined) {
          fail(`${relative}: imports ${specifier} but ${packageName} exports no "${subpath}"`)
        }
        continue
      }
      if (!packageName.startsWith('@deepseek-ai/')) continue
      if (typeOnly) continue
      // A browser source may only import platform-singleton modules.
      const browserSource = file.includes('/src/client/')
      if (browserSource) {
        if (!CLIENT_EXTERNALS.has(specifier)) {
          fail(`${relative}: browser bundle imports ${specifier}, which is not a DSH platform-singleton module`)
        }
        continue
      }
      // A host source must declare every runtime dependency as a peer so DSH
      // linked-root resolution routes it to the installation instance.
      if (!Object.hasOwn(peers, packageName)) {
        fail(`${relative}: runtime import ${specifier} must be in ${label} peerDependencies (linked-root routing)`)
      }
    }
  }
}

// ---- root devDependencies are actually used --------------------------------
const usedSpecifiers = new Set()
for (const { dirPath } of manifests) {
  for (const file of [...listSources(join(dirPath, 'src')), ...listSources(join(dirPath, 'tests'))]) {
    for (const { specifier } of importsOf(file)) usedSpecifiers.add(packageNameOf(specifier))
  }
}
for (const name of Object.keys(rootManifest.devDependencies ?? {})) {
  if (usedSpecifiers.has(name) || Object.hasOwn(DEV_INFRA, name)) continue
  fail(`root devDependency ${name} is not imported by any package source or test (and is not documented infra)`)
}
for (const [name, reason] of Object.entries(DEV_INFRA)) {
  if (rootManifest.devDependencies?.[name] === undefined) fail(`root devDependency ${name} is required for ${reason}`)
}

// ---- alias coverage --------------------------------------------------------
const tsconfig = readJson(join(ROOT, 'tsconfig.base.json'))
const tsconfigPaths = tsconfig.compilerOptions?.paths ?? {}
const tsconfigBase = tsconfig.compilerOptions?.baseUrl ?? '.'
const vitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
const workspaceSpecifiers = [...usedSpecifiers].filter(name => name.startsWith('@yankeguo/'))
const subpathSpecifiers = new Set()
for (const { dirPath } of manifests) {
  for (const file of [...listSources(join(dirPath, 'src')), ...listSources(join(dirPath, 'tests'))]) {
    for (const { specifier } of importsOf(file)) {
      if (specifier.startsWith('@yankeguo/')) subpathSpecifiers.add(specifier)
    }
  }
}
for (const specifier of subpathSpecifiers) {
  const targets = tsconfigPaths[specifier]
  if (!Array.isArray(targets) || targets.length === 0) {
    fail(`tsconfig.base.json paths is missing the "${specifier}" alias`)
    continue
  }
  for (const target of targets) {
    const absolute = resolve(ROOT, tsconfigBase, target)
    if (!existsSync(absolute)) fail(`tsconfig.base.json alias "${specifier}" points at a missing file: ${target}`)
  }
  if (!vitestConfig.includes(`'${specifier}'`) && !vitestConfig.includes(`"${specifier}"`)) {
    fail(`vitest.config.ts alias is missing "${specifier}" (tests resolve workspace imports through Vite aliases)`)
  }
}
if (workspaceSpecifiers.length === 0) notes.push('no workspace imports found (unexpected)')

// ---- bundle contract -------------------------------------------------------
const bundle = manifests.find(entry => entry.manifest.dsh?.bundle !== undefined)
if (bundle === undefined) {
  fail('no bundle package (dsh.bundle) found')
} else {
  const label = `packages/${bundle.dir}`
  const patch = bundle.manifest.dsh.bundle.patch
  const patchFiles = typeof patch === 'string' ? [patch] : patch
  if (!Array.isArray(patchFiles) || patchFiles.length === 0) fail(`${label}: dsh.bundle.patch must be a path or list of paths`)
  else for (const file of patchFiles) {
    if (typeof file !== 'string' || !existsSync(join(bundle.dirPath, file))) fail(`${label}: missing bundle patch ${file}`)
  }
  if (bundle.manifest.dsh.bundle.listedByDefault !== undefined
    && typeof bundle.manifest.dsh.bundle.listedByDefault !== 'boolean') {
    fail(`${label}: dsh.bundle.listedByDefault must be a boolean (as DSH 0.2.2-rc.1 requires)`)
  }
  if (typeof bundle.manifest.icon !== 'string' || !existsSync(join(bundle.dirPath, bundle.manifest.icon))) {
    fail(`${label}: bundle icon is missing`)
  }
  for (const name of Object.keys(bundle.manifest.dependencies ?? {})) {
    if (!workspaceByName.has(name)) fail(`${label}: dependency ${name} is not a workspace package`)
  }
}

// ---- lockfile importers ----------------------------------------------------
const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
if (!/^lockfileVersion: '9\.0'$/mu.test(lockfile)) fail("pnpm-lock.yaml: unexpected lockfileVersion (expected '9.0')")
if (!/^  \.:$/mu.test(lockfile)) fail('pnpm-lock.yaml: missing the root importer; run "pnpm install --lockfile-only"')
for (const { dir } of manifests) {
  if (!new RegExp(`^  packages/${dir}:$`, 'mu').test(lockfile)) {
    fail(`pnpm-lock.yaml: missing the packages/${dir} importer; run "pnpm install --lockfile-only"`)
  }
}

// ---- gitignore and workflows ----------------------------------------------
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
for (const pattern of ['node_modules/', 'packages/*/lib/', '.tmp/']) {
  if (!gitignore.split('\n').map(line => line.trim()).includes(pattern)) {
    fail(`.gitignore must ignore ${pattern}`)
  }
}
for (const script of ['build.mjs', 'clean.mjs', 'dev-patch.mjs', 'install-profile.mjs', 'trusted-publishers.sh', 'check-packages.mjs']) {
  if (!existsSync(join(ROOT, 'scripts', script))) fail(`scripts/${script} is missing`)
}
const workflowDir = join(ROOT, '.github', 'workflows')
for (const workflow of ['publish.yml', 'verify.yml']) {
  if (!existsSync(join(workflowDir, workflow))) fail(`.github/workflows/${workflow} is missing`)
}
const readWorkflow = name => existsSync(join(workflowDir, name)) ? readFileSync(join(workflowDir, name), 'utf8') : ''
const publish = readWorkflow('publish.yml')
const verify = readWorkflow('verify.yml')
for (const action of PINNED_ACTIONS) {
  if (!publish.includes(`${action}v`) || !verify.includes(`${action}v`)) fail(`${action} must be pinned in both workflows`)
}
const publishPin = [...publish.matchAll(/uses:\s*(\S+@v[\w.]+)/gu)].map(match => match[1]).sort()
const verifyPin = [...verify.matchAll(/uses:\s*(\S+@v[\w.]+)/gu)].map(match => match[1]).sort()
if (publishPin.length !== verifyPin.length || publishPin.some((pin, index) => pin !== verifyPin[index])) {
  fail(`workflows must use identical pinned action versions (publish: ${publishPin.join(', ')}; verify: ${verifyPin.join(', ')})`)
}
for (const [name, text] of [['publish.yml', publish], ['verify.yml', verify]]) {
  if (!text.includes(`version: ${PNPM_VERSION}`)) fail(`${name}: must pin pnpm ${PNPM_VERSION}`)
  if (!text.includes(`node-version: ${NODE_VERSION}`)) fail(`${name}: must pin Node ${NODE_VERSION}`)
}
if (!/permissions:\s*\n\s*contents: read/u.test(verify)) fail('verify.yml must declare read-only contents permission')
if (!/id-token: write/u.test(publish)) fail('publish.yml must declare id-token: write for OIDC publishing')

// ---- report ----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`check-packages: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`check-packages: OK (${manifests.length} packages)`)
for (const note of notes) console.log(`  note: ${note}`)
