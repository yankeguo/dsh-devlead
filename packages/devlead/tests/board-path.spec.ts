/** Deployment statePath grammar and shared board/notes directory resolution. */

import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import DevLeadService, { Config } from '../src/index.ts'
import { DevLeadBoardStore, resolveDevLeadStateDir } from '../src/board.ts'
import { bootService, disposeHarnesses } from './harness.ts'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-devlead-state-path-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await disposeHarnesses()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('statePath relative state directory', () => {
  it('defaults both board and notes to .dsh/devlead beneath the original workspace', async () => {
    const workspace = await tempRoot('default')
    expect(Config({}).statePath).toBe('.dsh/devlead')
    expect(resolveDevLeadStateDir({ cwd: workspace })).toEqual({
      kind: 'resolved',
      path: join(workspace, '.dsh', 'devlead'),
      source: 'workspace',
    })
    const harness = await bootService({ enabled: true, leadCwd: workspace })
    expect(harness.service.settings.statePath).toBe('.dsh/devlead')
    expect(harness.service.board.path).toBe(join(workspace, '.dsh', 'devlead', 'board.json'))
    expect(harness.service.notes.path).toBe(join(workspace, '.dsh', 'devlead', 'notes'))
    expect(harness.service.notes.indexPath).toBe(join(workspace, '.dsh', 'devlead', 'notes', 'index.json'))
    expect(harness.service.statePathOverride).toBe(false)
    await harness.service.updateBoard(harness.lead.agent, {
      project: 'alpha', create: true, set: { workspace: { path: workspace, title: 'alpha' } },
    })
    expect(existsSync(join(workspace, '.dsh', 'devlead', 'board.json'))).toBe(true)
  })

  it('derives board.json, notes index, and note read paths from one custom relative directory', async () => {
    const workspace = await tempRoot('custom')
    expect(resolveDevLeadStateDir({ statePath: 'custom/state', cwd: workspace })).toEqual({
      kind: 'resolved',
      path: join(workspace, 'custom', 'state'),
      source: 'override',
    })
    const harness = await bootService({
      enabled: true,
      leadCwd: workspace,
      config: { statePath: 'custom/state' },
    })
    const stateDir = join(workspace, 'custom', 'state')
    const notesRoot = join(stateDir, 'notes')
    expect(harness.service.settings.statePath).toBe('custom/state')
    expect(harness.service.board.path).toBe(join(stateDir, 'board.json'))
    expect(harness.service.notes.path).toBe(notesRoot)
    expect(harness.service.notes.indexPath).toBe(join(notesRoot, 'index.json'))
    expect(harness.service.statePathOverride).toBe(true)
    expect(existsSync(join(workspace, '.dsh', 'devlead', 'board.json'))).toBe(false)

    await harness.service.updateBoard(harness.lead.agent, {
      project: 'alpha', create: true, set: { workspace: { path: workspace, title: 'alpha' } },
    })
    const created = await harness.service.writeBoardNote(harness.lead.agent, {
      project: 'alpha', operation: 'create', note: 'release', title: 'Release',
    })
    const bodyPath = join(notesRoot, created.project.directory, 'release.md')
    expect(created.note.absolutePath).toBe(bodyPath)
    expect(existsSync(join(stateDir, 'board.json'))).toBe(true)
    expect(existsSync(join(notesRoot, 'index.json'))).toBe(true)
    expect(existsSync(bodyPath)).toBe(true)
    await writeFile(bodyPath, '# Release\n', 'utf8')
    const read = await harness.service.readBoardNote(harness.lead.agent, { project: 'alpha', note: 'release' })
    expect(read.note?.absolutePath).toBe(bodyPath)
    expect(read.note?.path).toBe(`${created.project.directory}/release.md`)
    expect(read.note?.bytes).toBe(Buffer.byteLength('# Release\n'))
    expect(JSON.parse(await readFile(join(notesRoot, 'index.json'), 'utf8'))).toMatchObject({
      projects: [{ id: 'alpha', notes: [{ id: 'release', path: `${created.project.directory}/release.md` }] }],
    })
  })

  it.each(['/tmp/x', 'C:\\x', 'C:/x', '\\\\server\\share', '//server/share'])(
    'rejects absolute statePath %s at Loader and direct construction',
    (statePath) => {
      expect(() => Config({ statePath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/statePath' })],
        message: expect.stringMatching(/relative directory/u),
      }))
      expect(() => new DevLeadService(new Context(), { statePath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/statePath' })],
        message: expect.stringMatching(/relative directory/u),
      }))
    },
  )

  it.each(['../x', 'a/../../x'])('rejects workspace escape %s without falling back to the default', (statePath) => {
    expect(() => Config({ statePath })).toThrowError(expect.objectContaining({
      code: 'BOARD_INVALID',
      issues: [expect.objectContaining({ pointer: '/statePath' })],
      message: expect.stringMatching(/within the lead workspace/u),
    }))
    expect(() => new DevLeadService(new Context(), { statePath })).toThrowError(expect.objectContaining({
      code: 'BOARD_INVALID',
      issues: [expect.objectContaining({ pointer: '/statePath' })],
      message: expect.stringMatching(/within the lead workspace/u),
    }))
    expect(() => resolveDevLeadStateDir({ statePath, cwd: '/workspace/alpha' }))
      .toThrowError(expect.objectContaining({ code: 'BOARD_INVALID' }))
  })

  it.each(['', '   ', 'custom//state', 'custom/', 'custom\\state'])(
    'rejects blank values, empty segments, and backslashes in %s',
    (statePath) => {
      expect(() => Config({ statePath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/statePath' })],
      }))
      expect(() => new DevLeadService(new Context(), { statePath })).toThrowError(expect.objectContaining({
        code: 'BOARD_INVALID',
        issues: [expect.objectContaining({ pointer: '/statePath' })],
      }))
      expect(() => resolveDevLeadStateDir({ statePath, cwd: '/workspace/alpha' }))
        .toThrowError(expect.objectContaining({ code: 'BOARD_INVALID' }))
    },
  )

  it('uses the original workspace rather than a worktree checkout for both stores', async () => {
    const original = await tempRoot('original')
    const checkout = await tempRoot('checkout')
    const harness = await bootService({
      enabled: true,
      leadCwd: original,
      config: { statePath: 'custom/state' },
    })
    // A worktree changes only the turn's effective cwd. SessionHeader.cwd stays
    // `original`; no checkout path is accepted by the state resolver or tools.
    expect(harness.leadSession.header.cwd).toBe(original)
    expect(harness.service.board.path).toBe(join(original, 'custom', 'state', 'board.json'))
    expect(harness.service.notes.path).toBe(join(original, 'custom', 'state', 'notes'))
    expect(harness.service.board.path).not.toBe(join(checkout, 'custom', 'state', 'board.json'))
    expect(harness.service.notes.path).not.toBe(join(checkout, 'custom', 'state', 'notes'))
  })

  it('still rejects a symlink as the final board.json component', async () => {
    const workspace = await tempRoot('symlink')
    const stateDir = join(workspace, 'custom', 'state')
    await mkdir(stateDir, { recursive: true })
    const target = join(stateDir, 'target.json')
    const boardFilePath = join(stateDir, 'board.json')
    const original = JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: { sessionId: 'session-lead', title: 'DevLead' },
      projects: [],
    })
    await writeFile(target, original, 'utf8')
    await symlink(target, boardFilePath, 'file')
    const store = new DevLeadBoardStore(boardFilePath)
    await expect(store.start()).rejects.toMatchObject({
      code: 'BOARD_INVALID',
      issues: [expect.objectContaining({ pointer: '/statePath' })],
      message: expect.stringMatching(/final path component.*symlink/u),
    })
    await expect(store.read()).rejects.toMatchObject({ code: 'BOARD_INVALID' })
    expect(await readFile(target, 'utf8')).toBe(original)
    await store.close()
  })

  it('accepts a symlink in the board parent directory chain', async () => {
    const workspace = await tempRoot('parent-symlink')
    const target = join(workspace, 'actual-state')
    await mkdir(target)
    await symlink(target, join(workspace, 'linked-state'), 'dir')
    const harness = await bootService({
      enabled: true,
      leadCwd: workspace,
      config: { statePath: 'linked-state' },
    })
    expect(harness.service.boardStartError).toBeUndefined()
    await harness.service.updateBoard(harness.lead.agent, {
      project: 'alpha', create: true, set: { workspace: { path: workspace, title: 'alpha' } },
    })
    expect(harness.service.board.path).toBe(join(workspace, 'linked-state', 'board.json'))
    expect(existsSync(join(target, 'board.json'))).toBe(true)
    expect(harness.service.notes.path).toBe(join(workspace, 'linked-state', 'notes'))
  })

  it('disables instead of fabricating a state directory without an absolute workspace', () => {
    expect(resolveDevLeadStateDir({})).toEqual({ kind: 'disabled', reason: 'no-workspace' })
    expect(resolveDevLeadStateDir({ cwd: 'relative/project' })).toEqual({
      kind: 'disabled', reason: 'relative-workspace',
    })
  })
})
