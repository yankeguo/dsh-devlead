/** Git scope and degradation of optional board commits. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { commitDevLeadBoard } from '../src/board-commit.ts'

const execute = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd })).stdout.trim()
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commitDevLeadBoard', () => {
  it('commits only .dsh/devlead and preserves unrelated staged/unstaged work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-commit-'))
    roots.push(root)
    await git(root, 'init')
    await git(root, 'config', 'user.name', 'DevLead Test')
    await git(root, 'config', 'user.email', 'devlead@example.invalid')
    await writeFile(join(root, 'README.md'), 'base\n')
    await git(root, 'add', 'README.md')
    await git(root, 'commit', '-m', 'base')
    await writeFile(join(root, 'staged.txt'), 'keep staged\n')
    await git(root, 'add', 'staged.txt')
    await writeFile(join(root, 'unstaged.txt'), 'keep untracked\n')
    const board = join(root, '.dsh', 'devlead', 'board.json')
    await mkdir(dirname(board), { recursive: true })
    await writeFile(board, '{"projects":[]}\n')

    const result = await commitDevLeadBoard(root)
    expect(result.warning).toBeUndefined()
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/u)
    expect(await git(root, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('.dsh/devlead/board.json')
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('staged.txt')
    expect(await readFile(join(root, 'unstaged.txt'), 'utf8')).toBe('keep untracked\n')
    expect(await git(root, 'status', '--porcelain')).toContain('?? unstaged.txt')
  })

  it('degrades a non-Git workspace to a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devlead-board-non-git-'))
    roots.push(root)
    const result = await commitDevLeadBoard(root)
    expect(result.commitHash).toBeUndefined()
    expect(result.warning).toContain('board was written but not committed')
  })

  it('uses fixed scoped argv and reports an add failure without throwing', async () => {
    const mutableCalls: string[][] = []
    const result = await commitDevLeadBoard('/lead', undefined, async (_cwd, args) => {
      mutableCalls.push([...args])
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/lead\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'injected add failure' }
    })
    expect(mutableCalls).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['add', '--', '.dsh/devlead'],
    ])
    expect(result.warning).toContain('injected add failure')
  })
})
