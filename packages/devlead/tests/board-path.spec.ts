/** Deployment boardPath grammar and lead-workspace-relative resolution. */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import DevLeadService, { Config } from '../src/index.ts'
import { DevLeadBoardStore, resolveDevLeadBoardPath } from '../src/board.ts'
import { bootService, disposeHarnesses } from './harness.ts'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-devlead-board-path-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await disposeHarnesses()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('boardPath relative override', () => {
  it('resolves a relative override beneath the original lead workspace root', async () => {
    const workspace = await tempRoot('relative')
    expect(resolveDevLeadBoardPath({ override: 'custom/board.json', cwd: workspace })).toEqual({
      kind: 'resolved',
      path: join(workspace, 'custom', 'board.json'),
      source: 'override',
    })
    const harness = await bootService({
      enabled: true,
      leadCwd: workspace,
      config: { boardPath: 'custom/board.json' },
    })
    expect(harness.service.settings.boardPath).toBe('custom/board.json')
    expect(harness.service.board.path).toBe(join(workspace, 'custom', 'board.json'))
    expect(harness.service.boardPathOverride).toBe(true)
  })

  it.each(['/tmp/x', 'C:\\x', 'C:/x', '\\\\server\\share', '//server/share'])(
    'rejects absolute boardPath %s at Loader and direct construction',
    (boardPath) => {
      expect(() => Config({ boardPath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/boardPath' })],
        message: expect.stringMatching(/relative to the lead workspace/u),
      }))
      expect(() => new DevLeadService(new Context(), { boardPath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/boardPath' })],
        message: expect.stringMatching(/relative to the lead workspace/u),
      }))
    },
  )

  it.each(['../x', 'a/../../x'])('rejects workspace escape %s without falling back to the default', (boardPath) => {
    expect(() => Config({ boardPath })).toThrowError(expect.objectContaining({
      code: 'BOARD_INVALID',
      issues: [expect.objectContaining({ pointer: '/boardPath' })],
      message: expect.stringMatching(/within the lead workspace/u),
    }))
    expect(() => new DevLeadService(new Context(), { boardPath })).toThrowError(expect.objectContaining({
      code: 'BOARD_INVALID',
      message: expect.stringMatching(/within the lead workspace/u),
    }))
    expect(() => resolveDevLeadBoardPath({ override: boardPath, cwd: '/workspace/alpha' }))
      .toThrowError(expect.objectContaining({ code: 'BOARD_INVALID' }))
  })

  it.each(['custom//board.json', 'custom/', 'custom\\board.json'])(
    'rejects empty segments and backslashes in %s',
    (boardPath) => {
      expect(() => Config({ boardPath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/boardPath' })],
      }))
      expect(() => new DevLeadService(new Context(), { boardPath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
      }))
    },
  )

  it('keeps blank values on the default original-workspace derivation', async () => {
    const workspace = await tempRoot('blank')
    for (const boardPath of ['', '   ', undefined]) {
      expect(resolveDevLeadBoardPath({
        ...boardPath === undefined ? {} : { override: boardPath }, cwd: workspace,
      })).toEqual({
        kind: 'resolved',
        path: join(workspace, '.dsh', 'devlead', 'board.json'),
        source: 'workspace',
      })
    }
    const harness = await bootService({ enabled: true, leadCwd: workspace, config: { boardPath: '   ' } })
    expect(harness.service.settings.boardPath).toBeUndefined()
    expect(harness.service.board.path).toBe(join(workspace, '.dsh', 'devlead', 'board.json'))
    expect(harness.service.boardPathOverride).toBe(false)
  })

  it('uses the original workspace rather than a worktree checkout for a relative override', async () => {
    const original = await tempRoot('original')
    const checkout = await tempRoot('checkout')
    const harness = await bootService({
      enabled: true,
      leadCwd: original,
      config: { boardPath: '.dsh/devlead/board.json' },
    })
    // A worktree changes only the turn's effective cwd. SessionHeader.cwd stays
    // `original`; no checkout path is accepted by the board resolver or tools.
    expect(harness.leadSession.header.cwd).toBe(original)
    expect(harness.service.board.path).toBe(join(original, '.dsh', 'devlead', 'board.json'))
    expect(harness.service.board.path).not.toBe(join(checkout, '.dsh', 'devlead', 'board.json'))
  })

  it('still rejects a symlink as the final board path component', async () => {
    const workspace = await tempRoot('symlink')
    const target = join(workspace, 'target.json')
    const boardPath = join(workspace, 'board.json')
    const original = JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: { sessionId: 'session-lead', title: 'DevLead' },
      projects: [],
    })
    await writeFile(target, original, 'utf8')
    await symlink(target, boardPath, 'file')
    const store = new DevLeadBoardStore(boardPath)
    await expect(store.start()).rejects.toMatchObject({
      code: 'BOARD_INVALID',
      message: expect.stringMatching(/final path component.*symlink/u),
    })
    await expect(store.read()).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(target, 'utf8')).toBe(original)
    await store.close()
  })
})
