#!/usr/bin/env node
/**
 * Build every plugin package into its `lib/` directory.
 *
 * Host entries are bundled with esbuild and externalize `@deepseek-ai/*`,
 * `@yankeguo/*`, and `node:*`: the DSH installation supplies the official
 * packages, and the workspace packages are installed alongside the bundle (or
 * resolved through the profile's linked roots) so every plugin shares one
 * protocol/core instance instead of embedding per-package copies. Browser
 * entries are bundled the same way and then wrapped in the client-module loader
 * factory format (`window.__ModuleLoader__.load({ id, factory })`), exactly
 * like the DSH shell's own client bundles: externals are resolved through the
 * module-table `require` handed to the factory, and the bundle must not inline
 * a second copy of a platform-singleton module (see CLIENT_EXTERNALS).
 *
 * The `bundle` package ships no build sources: its target validates
 * `dsh.bundle.patch`, the patch files, the icon, and the `files` list instead,
 * so a broken package cannot be published unnoticed.
 *
 * Usage:
 *   node scripts/build.mjs                      # every target
 *   node scripts/build.mjs --only client-ui     # one target (repeatable/comma separated)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CLIENT_EXTERNALS } from './client-externals.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/**
 * Every plugin package in build order.
 *
 * - `entries` builds host ESM entries from `src/<entry>.ts`.
 * - `client` additionally builds the browser half from `src/<client>.tsx` and
 *   wraps it for the client-module loader.
 * - `patchOnly` ships configuration assets instead of bundled code.
 */
const TARGETS = [
  { dir: 'protocol', entries: ['index', 'client'] },
  { dir: 'devlead', entries: ['index'] },
  { dir: 'tool', entries: ['index'] },
  { dir: 'command', entries: ['index'] },
  { dir: 'client-ui', entries: ['index'], client: 'client/index' },
  { dir: 'bundle', patchOnly: true },
]

/** Shared esbuild options for a Host plugin bundle. */
const HOST_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  jsx: 'automatic',
  jsxImportSource: 'react',
  legalComments: 'none',
  logLevel: 'warning',
  // The DSH installation resolves official packages at runtime; our own
  // workspace packages are installed alongside the bundle and stay external so
  // one shared protocol/core instance is used instead of per-package copies.
  external: ['@deepseek-ai/*', '@yankeguo/*', 'node:*'],
  banner: { js: '// Built by dsh-devlead. Do not edit.' },
}

/**
 * Reject a browser import of an `@deepseek-ai/*` package that is not a
 * platform singleton. Such an import would inline a second runtime instance of
 * a plugin-owned module; the shell's module table cannot answer for it and the
 * DSH client build rejects the same shape ("bundle purity"). Type-only imports
 * never reach esbuild, and our own `@yankeguo/*` wire layers are pure code that
 * may be inlined.
 */
const clientModuleTableGuard = {
  name: 'client-module-table-guard',
  setup(context) {
    context.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
      if (CLIENT_EXTERNALS.includes(args.path)) return undefined
      throw new Error(
        `${args.importer}: imports "${args.path}", which is not a DSH platform-singleton module.\n`
        + '  A browser bundle may only import @deepseek-ai/* from the module table '
        + `(${CLIENT_EXTERNALS.join(', ')}) or inline a pure wire layer.\n`
        + '  Make the import type-only, or — only when DSH 0.2.2-rc.1 seeds it in '
        + 'packages/client/web/src/platform.ts — add it to scripts/client-externals.mjs.',
      )
    })
  },
}

/** Shared esbuild options for a browser bundle. */
const CLIENT_OPTIONS = {
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox110'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  legalComments: 'none',
  logLevel: 'warning',
  external: CLIENT_EXTERNALS,
  plugins: [clientModuleTableGuard],
}

/** Read and parse one package manifest. */
async function readManifest(dir) {
  return JSON.parse(await readFile(join(PACKAGES, dir, 'package.json'), 'utf8'))
}

/** Build one Host-side entry point. */
async function buildHostEntry(dir, entry) {
  const outfile = join(PACKAGES, dir, 'lib', `${entry}.js`)
  await build({
    ...HOST_OPTIONS,
    entryPoints: [join(PACKAGES, dir, 'src', `${entry}.ts`)],
    outfile,
  })
  return outfile
}

/** Build the browser bundle and wrap it in the client-module loader format. */
async function buildClientEntry(dir, entry, packageName) {
  const outfile = join(PACKAGES, dir, 'lib', 'client.js')
  const result = await build({
    ...CLIENT_OPTIONS,
    entryPoints: [join(PACKAGES, dir, 'src', `${entry}.tsx`)],
    write: false,
  })
  const code = result.outputFiles[0]?.text
  if (code === undefined) throw new Error(`${dir}: esbuild produced no client output`)
  // Same handoff shape as the DSH shell's client bundles: registration runs at
  // script evaluation, the factory body (and every module side effect) runs on
  // first materialization with the injected module-table `require`.
  const wrapped = [
    `window.__ModuleLoader__.load({`,
    `\tid: ${JSON.stringify(packageName)},`,
    `\tfactory: (require) => {`,
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    code.split('\n').map(line => (line.length > 0 ? `\t\t${line}` : line)).join('\n'),
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, wrapped)
  return outfile
}

/**
 * Fail when a manifest export or `main` points at a file the build did not
 * produce, or when `files` does not cover the `lib/` output.
 * @param dir - package directory name.
 * @param manifest - parsed package manifest.
 */
async function validateSourcePackage(dir, manifest) {
  const packageDir = join(PACKAGES, dir)
  const relativeTargets = []
  if (typeof manifest.main === 'string') relativeTargets.push(manifest.main)
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') relativeTargets.push(value)
    else if (value !== null && typeof value === 'object') {
      for (const target of Object.values(value)) if (typeof target === 'string') relativeTargets.push(target)
    }
  }
  const missing = relativeTargets.filter((target) => target.startsWith('./lib/')
    && !existsSync(join(packageDir, target)))
  if (missing.length > 0) {
    throw new Error(`${dir}: manifest references files the build did not produce: ${missing.join(', ')}`)
  }
  if (!Array.isArray(manifest.files) || !manifest.files.some(file => file === 'lib' || file.startsWith('lib/'))) {
    throw new Error(`${dir}: package.json "files" must include "lib" so the published package carries the build`)
  }
}

/**
 * Validate the client-module declaration consumed by `@deepseek-ai/dsh-client-modules`.
 * @param dir - package directory name.
 * @param manifest - parsed package manifest.
 */
async function validateClientPackage(dir, manifest) {
  const client = manifest.dsh?.client
  if (client === undefined) return
  if (client.platform !== 'web') {
    throw new Error(`${dir}: dsh.client.platform must be "web" for the Web surface (got ${JSON.stringify(client.platform)})`)
  }
  const clientExport = manifest.exports?.['./client']
  const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (target !== './lib/client.js') {
    throw new Error(`${dir}: dsh.client requires exports["./client"] === "./lib/client.js" (got ${JSON.stringify(target)})`)
  }
  if (!existsSync(join(PACKAGES, dir, 'lib', 'client.js'))) {
    throw new Error(`${dir}: missing built browser bundle lib/client.js`)
  }
}

/**
 * Parse the quoted `name:` values of one bundle patch file.
 * The bundle patch is plain YAML without a parser dependency; the shape is
 * pinned by the DSH bundle convention (`- insert:` rows with `id` and `name`).
 * @param path - absolute patch file path.
 * @returns inserted row ids and module names.
 */
async function readBundlePatch(path) {
  const text = await readFile(path, 'utf8')
  if (!/^- insert:\s*$/m.test(text)) {
    throw new Error(`${path}: a bundle patch must start with an "- insert:" row list`)
  }
  const names = [...text.matchAll(/^\s+name:\s*(['"])(.+?)\1\s*$/gm)].map(match => match[2])
  const ids = [...text.matchAll(/^\s+- id:\s*(['"]?)([A-Za-z0-9._-]+)\1\s*$/gm)].map(match => match[2])
  if (names.length === 0 || ids.length === 0) {
    throw new Error(`${path}: no id/name rows found in the insert list`)
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${path}: duplicate Loader row ids: ${ids.join(', ')}`)
  }
  return { names, ids }
}

/**
 * Validate a patch-only bundle package: manifest declaration, patch files,
 * icon, `files` completeness, and that the patch inserts every dependency.
 * @param dir - package directory name.
 * @param manifest - parsed package manifest.
 */
async function validatePatchBundle(dir, manifest) {
  const packageDir = join(PACKAGES, dir)
  const patch = manifest.dsh?.bundle?.patch
  const patchFiles = typeof patch === 'string' ? [patch] : patch
  if (!Array.isArray(patchFiles) || patchFiles.length === 0
    || !patchFiles.every(file => typeof file === 'string' && file.trim().length > 0)) {
    throw new Error(`${dir}: dsh.bundle.patch must be a patch file path or a non-empty list of them`)
  }
  if (typeof manifest.icon !== 'string' || !manifest.icon.trim().endsWith('.svg')) {
    throw new Error(`${dir}: a bundle should declare an SVG "icon" for the plugin manager`)
  }
  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .map(file => String(file).replace(/^\.\//u, ''))
  const declaredPaths = [...patchFiles, manifest.icon, 'README.md'].map(file => file.replace(/^\.\//u, ''))
  const missingFiles = declaredPaths.filter(file => !files.includes(file))
  if (missingFiles.length > 0) {
    throw new Error(`${dir}: package.json "files" must include ${missingFiles.join(', ')} so the published bundle is complete`)
  }
  const insertedNames = []
  const insertedIds = []
  for (const file of patchFiles) {
    const path = join(packageDir, file)
    if (!existsSync(path)) {
      throw new Error(`${dir}: dsh.bundle.patch references a missing file: ${file}`)
    }
    const { names, ids } = await readBundlePatch(path)
    insertedNames.push(...names)
    insertedIds.push(...ids)
  }
  if (new Set(insertedIds).size !== insertedIds.length) {
    throw new Error(`${dir}: duplicate Loader row ids across the bundle patches: ${insertedIds.join(', ')}`)
  }
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const unknown = insertedNames.filter(name => !dependencies.includes(name))
  const notInserted = dependencies.filter(name => !insertedNames.includes(name))
  if (unknown.length > 0 || notInserted.length > 0) {
    throw new Error(
      `${dir}: the bundle patch must insert exactly the bundle's runtime dependencies.\n`
      + `  not a dependency: ${unknown.join(', ') || '-'}\n`
      + `  dependency never inserted: ${notInserted.join(', ') || '-'}`,
    )
  }
  const svg = await readFile(join(packageDir, manifest.icon), 'utf8')
  if (!svg.trimStart().startsWith('<svg')) throw new Error(`${dir}: ${manifest.icon} is not an SVG document`)
}

/** Build transpiled entries of one source package (host half plus browser half). */
async function buildSourceEntries(target, packageDir) {
  const manifest = await readManifest(target.dir)
  await rm(join(packageDir, 'lib'), { recursive: true, force: true })
  await mkdir(join(packageDir, 'lib'), { recursive: true })
  for (const entry of target.entries) {
    if (!existsSync(join(packageDir, 'src', `${entry}.ts`))) {
      throw new Error(`${target.dir}: missing host entry src/${entry}.ts`)
    }
    const outfile = await buildHostEntry(target.dir, entry)
    console.log(`built ${outfile.slice(ROOT.length + 1)}`)
  }
  if (target.client !== undefined) {
    const browserEntry = join(packageDir, 'src', `${target.client}.tsx`)
    if (!existsSync(browserEntry)) {
      throw new Error(`${target.dir}: missing client entry src/${target.client}.tsx`)
    }
    const outfile = await buildClientEntry(target.dir, target.client, manifest.name)
    console.log(`built ${outfile.slice(ROOT.length + 1)}`)
  }
  await validateSourcePackage(target.dir, manifest)
  await validateClientPackage(target.dir, manifest)
}

/** Build one plugin package. */
async function buildPackage(target) {
  const packageDir = join(PACKAGES, target.dir)
  if (!existsSync(packageDir)) {
    throw new Error(`build: missing package directory packages/${target.dir}`)
  }
  if (target.patchOnly === true) {
    await validatePatchBundle(target.dir, await readManifest(target.dir))
    console.log(`validated ${target.dir} (patch-only)`)
    return
  }
  await buildSourceEntries(target, packageDir)
}

/** Parse `--only <dirs>` / `--only=<dirs>` from argv. */
function parseOnly(argv) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--only') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--only needs a comma-separated package directory list')
      values.push(value)
      index += 1
      continue
    }
    if (arg.startsWith('--only=')) {
      values.push(arg.slice('--only='.length))
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/build.mjs [--only <dir>[,<dir>...]]')
      process.exit(0)
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  const names = values.flatMap(value => value.split(',').map(name => name.trim()).filter(Boolean))
  if (values.length > 0 && names.length === 0) throw new Error('--only needs at least one package directory')
  return [...new Set(names)]
}

try {
  const only = parseOnly(process.argv.slice(2))
  const known = TARGETS.map(target => target.dir)
  for (const dir of only) {
    if (!known.includes(dir)) throw new Error(`--only: unknown package directory "${dir}" (known: ${known.join(', ')})`)
  }
  const selected = only.length === 0 ? TARGETS : TARGETS.filter(target => only.includes(target.dir))
  for (const target of selected) await buildPackage(target)
  console.log(`build complete (${selected.length} target${selected.length === 1 ? '' : 's'})`)
} catch (error) {
  console.error(`build: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
