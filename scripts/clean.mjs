#!/usr/bin/env node
/** Remove every built `lib/` directory and the generated dev overlay. */
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

try {
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await rm(join(ROOT, 'packages', entry.name, 'lib'), { recursive: true, force: true })
  }
  await rm(join(ROOT, '.tmp', 'cordis.patch.yml'), { force: true })
  console.log('cleaned')
} catch (error) {
  console.error(`clean: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
