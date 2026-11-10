/**
 * Display-metadata contract of the publishable suite packages.
 *
 * The DSH plugin manager renders a package's user-facing title and description
 * from `locale/<language>.json` (`{"meta":{"title":"...","description":"..."}}`),
 * resolved as `<package-name>/locale/en.json` through the package exports map;
 * every sibling *.json file is then read as a translation keyed by its lowercase
 * language id. Without those files the manager silently falls back to the
 * package name and the package.json description, so this spec guards the
 * shipped metadata and the exports wiring that makes it resolvable. The same
 * rules are enforced for CI by scripts/check-packages.mjs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Repository root, resolved from packages/devlead/tests/. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PACKAGES = join(ROOT, 'packages')
const LANGUAGES = ['en', 'zh'] as const

/**
 * Marketing superlatives banned from published display text.
 *
 * Keep this list aligned with BANNED_SUPERLATIVES in scripts/check-packages.mjs
 * (the dependency-free check cannot import a TypeScript test). ASCII entries
 * match whole lowercase words; CJK entries match substrings (specific
 * superlative phrases, so legitimate words such as 最近 are not rejected).
 */
const BANNED_SUPERLATIVES: readonly string[] = [
  'best', 'world-class', 'powerful', 'seamless', 'seamlessly', 'ultimate',
  'leading', 'top-tier', 'cutting-edge', 'state-of-the-art', 'revolutionary',
  'game-changing', 'unmatched', 'effortless', 'supercharge', 'next-generation',
  'premier', '最佳', '最强', '最优', '最先进', '最高级', '最领先', '第一',
  '唯一', '极致', '顶级', '业界领先', '世界级',
]

/** One package directory with its parsed manifest. */
interface PackageEntry {
  dir: string
  label: string
  dirPath: string
  manifest: Record<string, unknown>
}

/** Narrow a parsed JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and parse a JSON object, failing the test with the file path when invalid. */
function readJsonObject(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`${file} must contain a JSON object`)
  return parsed
}

/** Read a locale file and return its `meta` object (empty when absent). */
function metaOf(file: string): Record<string, unknown> {
  const meta = readJsonObject(file).meta
  return isRecord(meta) ? meta : {}
}

/** Read a non-empty display string. */
function displayTextOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Find the first banned superlative in display text. */
function bannedSuperlativeIn(text: string): string | undefined {
  const lower = text.toLowerCase()
  for (const word of BANNED_SUPERLATIVES) {
    const ascii = /^[\x00-\x7F]+$/u.test(word)
    if (ascii ? new RegExp(`\\b${word}\\b`, 'u').test(lower) : lower.includes(word)) return word
  }
  return undefined
}

/** Every package directory that carries a package.json, sorted by path. */
function discoverPackages(): PackageEntry[] {
  const entries: PackageEntry[] = []
  for (const dir of readdirSync(PACKAGES).sort()) {
    const dirPath = join(PACKAGES, dir)
    const manifestPath = join(dirPath, 'package.json')
    if (!existsSync(manifestPath)) continue
    entries.push({ dir, label: `packages/${dir}`, dirPath, manifest: readJsonObject(manifestPath) })
  }
  return entries
}

const packages = discoverPackages()
const publishable = packages.filter(entry => entry.manifest.private !== true)

describe('plugin display metadata', () => {
  it('discovers the publishable packages', () => {
    expect(publishable.length).toBeGreaterThanOrEqual(6)
  })

  for (const pkg of publishable) {
    describe(pkg.label, () => {
      it('packs and exports its locale directory', () => {
        const files = pkg.manifest.files
        expect(Array.isArray(files), `${pkg.label}: package.json "files" must be an array`).toBe(true)
        expect(Array.isArray(files) && files.includes('locale/*.json'), `${pkg.label}: package.json "files" must include "locale/*.json" so display metadata is published`).toBe(true)
        const exportsMap = pkg.manifest.exports
        expect(isRecord(exportsMap), `${pkg.label}: package.json "exports" must be an object`).toBe(true)
        expect(isRecord(exportsMap) ? exportsMap['./locale/*.json'] : undefined, `${pkg.label}: package.json must map "./locale/*.json" to "./locale/*.json"`).toBe('./locale/*.json')
      })

      for (const language of LANGUAGES) {
        it(`resolves ${language} display metadata through the package exports`, () => {
          const file = join(pkg.dirPath, 'locale', `${language}.json`)
          expect(existsSync(file), `${file} must exist`).toBe(true)
          const meta = metaOf(file)
          const title = displayTextOf(meta.title)
          const description = displayTextOf(meta.description)
          expect(title, `${file}: meta.title must be a non-empty string`).toBeDefined()
          expect(description, `${file}: meta.description must be a non-empty string`).toBeDefined()
          for (const [field, value] of [['title', title], ['description', description]] as const) {
            if (value === undefined) continue
            const banned = bannedSuperlativeIn(value)
            expect(banned, `${file}: meta.${field} uses the banned superlative "${banned}"`).toBeUndefined()
          }
          // Node's package self-reference resolves through the exports map: the
          // same exports semantics the DSH plugin-manager resolver relies on.
          const name = pkg.manifest.name
          expect(typeof name, `${pkg.label}: package.json "name" must be a string`).toBe('string')
          if (typeof name !== 'string') return
          const require = createRequire(pathToFileURL(join(pkg.dirPath, 'package.json')))
          const resolved = require.resolve(`${name}/locale/${language}.json`)
          expect(resolved.endsWith(join('locale', `${language}.json`))).toBe(true)
          const resolvedMeta = metaOf(resolved)
          expect(displayTextOf(resolvedMeta.title)).toBe(title)
          expect(displayTextOf(resolvedMeta.description)).toBe(description)
        })
      }
    })
  }

  for (const language of LANGUAGES) {
    it(`uses unique ${language} titles across packages`, () => {
      const seen = new Map<string, string>()
      for (const pkg of publishable) {
        const file = join(pkg.dirPath, 'locale', `${language}.json`)
        const title = existsSync(file) ? displayTextOf(metaOf(file).title) : undefined
        if (title === undefined) continue
        expect(seen.has(title), `duplicate ${language} title "${title}": ${pkg.label} and ${seen.get(title)}`).toBe(false)
        seen.set(title, pkg.label)
      }
      expect(seen.size).toBe(publishable.length)
    })
  }

  it('keeps the bundle icon file that the plugin manager renders', () => {
    const bundle = packages.find((entry) => {
      const dsh = entry.manifest.dsh
      return isRecord(dsh) && isRecord(dsh.bundle)
    })
    expect(bundle, 'no bundle package (dsh.bundle) found').toBeDefined()
    if (bundle === undefined) return
    const icon = bundle.manifest.icon
    expect(typeof icon, `${bundle.label}: bundle icon must be a path string`).toBe('string')
    if (typeof icon !== 'string') return
    expect(existsSync(join(bundle.dirPath, icon)), `${bundle.label}: missing bundle icon file ${icon}`).toBe(true)
  })
})
