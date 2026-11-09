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
 * factory format (`window.__ModuleLoader__.load`), externalizing exactly the
 * shell's platform-singleton module seeding (`packages/client/web/src/seed.ts`
 * in DeepSeek Harness).
 *
 * A package that ships no build sources (`source: false`) contributes only
 * hand-written runtime assets copied verbatim into `lib/`
 * (`disable-goal-bundle/src/preset-filter.js`). Assets are copied, not
 * transpiled, so a `pnpm clean` + `pnpm build` reproduces the published file
 * byte for byte.
 *
 * Usage:
 *   node scripts/build.mjs                      # every target
 *   node scripts/build.mjs --only client-ui     # one target (repeatable/comma separated)
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/**
 * Every plugin package in build order.
 *
 * `assets` lists hand-written runtime files copied into `lib/` after the target
 * directory is cleaned; those packages are not transpiled.
 */
const TARGETS = [
  { dir: 'protocol', entries: ['index', 'client'] },
  { dir: 'devlead', entries: ['index'] },
  { dir: 'tool', entries: ['index'] },
  { dir: 'command', entries: ['index'] },
  { dir: 'client-ui', entries: ['index'], client: 'client/index' },
  // Patch-only bundle: `dsh.bundle.patch` points at cordis.patch.yml.
  { dir: 'bundle', source: false },
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
  // Platform modules shared by the browser shell through the module table.
  // This list must stay identical to the Harness shell's platform-singleton
  // seed (`packages/client/web/src/seed.ts`); a drift makes the loader throw
  // "require(...) missed the module table" at runtime.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    'zod',
    '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
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

/** Copy one hand-written runtime asset into the package's `lib/`. */
async function copyAsset(dir, asset) {
  const from = join(PACKAGES, dir, asset.from)
  const to = join(PACKAGES, dir, asset.to)
  if (!existsSync(from)) throw new Error(`${dir}: missing runtime asset ${asset.from}`)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  return to
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
}

/** Build one plugin package. */
async function buildPackage(target) {
  const packageDir = join(PACKAGES, target.dir)
  if (!existsSync(packageDir)) {
    throw new Error(`build: missing package directory packages/${target.dir}`)
  }
  if (target.source !== false) await buildSourceEntries(target, packageDir)
  if (target.assets !== undefined) {
    // A target that ships only hand-written runtime assets owns nothing else in
    // `lib/`: clean it so a removed asset cannot survive as a stale file.
    if (target.source === false) await rm(join(packageDir, 'lib'), { recursive: true, force: true })
    for (const asset of target.assets) {
      const outfile = await copyAsset(target.dir, asset)
      console.log(`built ${outfile.slice(ROOT.length + 1)}`)
    }
  }
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
  return values.flatMap(value => value.split(',').map(name => name.trim()).filter(Boolean))
}

const only = parseOnly(process.argv.slice(2))
const known = new Set(TARGETS.map(target => target.dir))
for (const dir of only) {
  if (!known.has(dir)) throw new Error(`--only: unknown package directory "${dir}" (known: ${[...known].join(', ')})`)
}
const selected = only.length === 0 ? TARGETS : TARGETS.filter(target => only.includes(target.dir))
for (const target of selected) {
  await buildPackage(target)
}
console.log('build complete')
