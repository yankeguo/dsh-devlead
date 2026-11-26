/** Service-level optional board commits against real temporary repositories. */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { bootService } from './harness.ts'

const execute = promisify(execFile)
const roots: string[] = []

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd })).stdout.trim()
}

afterEach(async () => {
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true })
})

describe('DevLeadService.updateBoard commit option', () => {
  it('commit:true commits only .dsh/devlead and skips a no-op', async () => {
    const workspace = await root('dsh-devlead-service-commit-')
    await git(workspace, 'init')
    await git(workspace, 'config', 'user.name', 'DevLead Test')
    await git(workspace, 'config', 'user.email', 'devlead@example.invalid')
    await writeFile(join(workspace, 'README.md'), 'base\n')
    await git(workspace, 'add', 'README.md')
    await git(workspace, 'commit', '-m', 'base')
    await writeFile(join(workspace, 'staged.txt'), 'unrelated\n')
    await git(workspace, 'add', 'staged.txt')
    await writeFile(join(workspace, 'unstaged.txt'), 'also unrelated\n')
    const harness = await bootService({ enabled: true, leadCwd: workspace })
    try {
      const patch = {
        project: 'alpha', create: true,
        set: { workspace: { path: workspace, title: 'alpha' }, focus: 'committed' },
      }
      const result = await harness.service.updateBoard(harness.lead.agent, patch, undefined, undefined, { commit: true })
      expect(result.warning).toBeUndefined()
      expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/u)
      expect(await git(workspace, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('.dsh/devlead/board.json')
      expect(await git(workspace, 'diff', '--cached', '--name-only')).toBe('staged.txt')
      expect(await readFile(join(workspace, 'unstaged.txt'), 'utf8')).toBe('also unrelated\n')
      const head = result.commitHash
      const noop = await harness.service.updateBoard(harness.lead.agent, patch, undefined, undefined, { commit: true })
      expect(noop.changed).toEqual([])
      expect(noop.commitHash).toBeUndefined()
      expect(await git(workspace, 'rev-parse', 'HEAD')).toBe(head)
    } finally {
      await harness.dispose()
    }
  })

  it('returns a warning after writing outside Git', async () => {
    const workspace = await root('dsh-devlead-service-non-git-')
    const harness = await bootService({ enabled: true, leadCwd: workspace })
    try {
      const result = await harness.service.updateBoard(harness.lead.agent, {
        project: 'alpha', create: true,
        set: { workspace: { path: workspace, title: 'alpha' } },
      }, undefined, undefined, { commit: true })
      expect(result.commitHash).toBeUndefined()
      expect(result.warning).toContain('board was written but not committed')
      expect((await harness.service.readBoard(harness.lead.agent)).projects[0]?.id).toBe('alpha')
    } finally {
      await harness.dispose()
    }
  })
})
