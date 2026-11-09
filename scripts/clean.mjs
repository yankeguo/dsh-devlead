#!/usr/bin/env node
/** Remove every built `lib/` directory. */
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  await rm(join(ROOT, 'packages', entry.name, 'lib'), { recursive: true, force: true })
}
console.log('cleaned')
