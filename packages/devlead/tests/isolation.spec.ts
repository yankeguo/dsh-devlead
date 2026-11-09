/**
 * Optional Git-worktree isolation of DevLead-created Sessions.
 *
 * The service treats the experimental `ctx.worktrees` capability as best
 * effort: it must never be required, never be imported, and never turn a
 * creation failure into a rejected call. These specs prove every state of that
 * contract, plus the ordering guarantee that a worktree is created while the
 * new Session's Agent is still blank and therefore before its initial prompt is
 * admitted.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  FAKE_WORKTREE,
  FakeAgent,
  FakeSessionController,
  FakeWorkspaceRegistry,
  FakeWorktreesCapability,
  bootService,
  disposeHarnesses,
  messageText,
} from './harness.ts'
import type { BootServiceOptions, ServiceHarness } from './harness.ts'
import type { WorktreeCheckout } from '../src/isolation.ts'

/** Workspace path the fake registry hosts for every creation below. */
const WORKSPACE_PATH = '/tmp/devlead-isolation-space'

/** Identity the scripted Session controller mints. */
const CREATED_ID = 'created-session'

afterEach(async () => {
  await disposeHarnesses()
})

/** One booted creation harness plus the fakes whose calls the specs inspect. */
interface CreationHarness {
  readonly harness: ServiceHarness
  readonly controller: FakeSessionController
  readonly registry: FakeWorkspaceRegistry
}

/**
 * Boot one enabled harness whose Session controller and Workspace registry are
 * ready for `createSession`.
 * @param options - optional fake worktree capability to compose.
 * @returns the booted harness and its creation fakes.
 */
async function bootCreation(options: Pick<BootServiceOptions, 'worktrees'> = {}): Promise<CreationHarness> {
  const controller = new FakeSessionController()
  const registry = new FakeWorkspaceRegistry()
  registry.add({ path: WORKSPACE_PATH, title: 'Isolation Space' })
  const harness = await bootService({
    enabled: true,
    sessionController: controller,
    workspaceRegistry: registry,
    ...options,
  })
  return { harness, controller, registry }
}

/**
 * Script the Session controller to create one Session whose Agent is live in
 * the fake Agent registry, the way a real controller leaves it.
 * @param harness - booted harness.
 * @param controller - Session controller fake to script.
 * @param id - Session identity to mint.
 */
function scriptCreateLiveSession(
  harness: ServiceHarness,
  controller: FakeSessionController,
  id: string = CREATED_ID,
): void {
  controller.createHandler = () => {
    const session = harness.ctx.sessions.create(SessionId(id))
    harness.agents.add(new FakeAgent(session))
    return { sessionId: session.id }
  }
}

/**
 * Read the required live fake Agent of one created Session.
 * @param harness - booted harness.
 * @param id - created Session identity.
 * @returns the live fake Agent.
 */
function liveChild(harness: ServiceHarness, id: string = CREATED_ID): FakeAgent {
  const child = harness.agents.resolve(id)
  if (child === undefined) throw new Error(`expected a live fake Agent "${id}"`)
  return child
}

/**
 * Read the single admitted message of one fake Agent.
 * @param agent - fake Agent whose inbox is inspected.
 * @returns the admitted user message.
 */
function admittedMessage(agent: FakeAgent) {
  const message = agent.followups[0]
  if (message === undefined) throw new Error('expected one admitted prompt')
  return message
}

describe('session creation with optional worktree isolation', () => {
  it('reports no isolation for a request that does not ask for one', async () => {
    const worktrees = new FakeWorktreesCapability()
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)

    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      prompt: 'plain work',
    })
    expect(result.isolation).toEqual({ requested: 'none', status: 'none' })
    expect(worktrees.calls).toEqual([])
    expect(result.prompted).toBe(true)
    expect(liveChild(harness).followups).toHaveLength(1)
  })

  it('creates one worktree for the live child Agent before admitting the prompt', async () => {
    const worktrees = new FakeWorktreesCapability()
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)
    const cancellation = new AbortController()

    const result = await harness.service.createSession(
      harness.lead.agent,
      {
        workspace: WORKSPACE_PATH,
        title: 'Isolated Work',
        prompt: 'build the isolated change',
        isolation: 'worktree',
      },
      cancellation.signal,
    )

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'worktree',
      path: FAKE_WORKTREE.path,
      branch: FAKE_WORKTREE.branch,
      baseCommit: FAKE_WORKTREE.baseCommit,
    })
    expect(result.prompted).toBe(true)
    expect(result.session).toMatchObject({ sessionId: CREATED_ID, live: true, watched: true })

    // Exactly one creation, owned by the exact live child Agent: the service
    // moves the CHILD's working directory, never the lead's.
    expect(worktrees.calls).toHaveLength(1)
    const call = worktrees.calls[0]
    if (call === undefined) throw new Error('expected one worktree creation call')
    const child = liveChild(harness)
    expect(call.agent).toBe(child.agent)
    expect(call.agent).toBe(harness.agents.get(SessionId(CREATED_ID)))
    expect(call.request).toEqual({})
    expect(call.signal).toBe(cancellation.signal)

    // Ordering: the child was still blank when the worktree was created, and
    // the prompt was admitted only afterwards.
    expect(call.followupsAtCall).toBe(0)
    expect(child.followups).toHaveLength(1)
    expect(messageText(admittedMessage(child))).toContain('build the isolated change')
  })

  it('reports unavailable when the Host composes no worktree capability', async () => {
    const { harness, controller } = await bootCreation()
    scriptCreateLiveSession(harness, controller)

    expect(harness.service.worktreeIsolationAvailable).toBe(false)
    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      prompt: 'start anyway',
      isolation: 'worktree',
    })

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'unavailable',
      reason: expect.stringContaining('no Git worktree service'),
    })
    expect(result.isolation).not.toHaveProperty('path')
    expect(result.prompted).toBe(true)
    expect(harness.ctx.sessions.get(SessionId(CREATED_ID))).toBeDefined()
    expect(liveChild(harness).followups).toHaveLength(1)
  })

  it('reports unavailable when the created Session Agent is not live', async () => {
    const worktrees = new FakeWorktreesCapability()
    const { harness, controller } = await bootCreation({ worktrees })
    controller.createHandler = () => {
      const session = harness.ctx.sessions.create(SessionId(CREATED_ID))
      return { sessionId: session.id }
    }

    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      isolation: 'worktree',
    })

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'unavailable',
      reason: expect.stringContaining('is not live'),
    })
    expect(worktrees.calls).toEqual([])
    expect(result.prompted).toBe(false)
    expect(harness.ctx.sessions.get(SessionId(CREATED_ID))).toBeDefined()
  })

  it('reports a worktree creation failure without rejecting the call', async () => {
    const worktrees = new FakeWorktreesCapability()
    worktrees.createError = new Error('git exploded')
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')

    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      prompt: 'start anyway',
      isolation: 'worktree',
    })

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'failed',
      reason: 'git exploded',
    })
    expect(worktrees.calls).toHaveLength(1)
    expect(result.prompted).toBe(true)
    expect(liveChild(harness).followups).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const warning = warn.mock.calls[0]?.[0]
    expect(String(warning)).toContain('git exploded')
    expect(String(warning)).toContain(CREATED_ID)
    warn.mockRestore()
  })

  it('reports a malformed checkout result as failed instead of a broken worktree outcome', async () => {
    const worktrees = new FakeWorktreesCapability()
    worktrees.createHandler = () => ({ path: '/tmp/worktree', branch: '', baseCommit: '' } as WorktreeCheckout)
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')

    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      prompt: 'start anyway',
      isolation: 'worktree',
    })

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'failed',
      reason: expect.stringContaining('unusable checkout'),
    })
    expect(result.isolation).not.toHaveProperty('path')
    expect(result.prompted).toBe(true)
    expect(liveChild(harness).followups).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('treats a malformed worktree service as unavailable', async () => {
    const malformed = {} as unknown as FakeWorktreesCapability
    const { harness, controller } = await bootCreation({ worktrees: malformed })
    scriptCreateLiveSession(harness, controller)

    expect(harness.service.worktreeIsolationAvailable).toBe(false)
    const result = await harness.service.createSession(harness.lead.agent, {
      workspace: WORKSPACE_PATH,
      prompt: 'start anyway',
      isolation: 'worktree',
    })

    expect(result.isolation).toEqual({
      requested: 'worktree',
      status: 'unavailable',
      reason: expect.stringContaining('no Git worktree service'),
    })
    expect(result.prompted).toBe(true)
    expect(liveChild(harness).followups).toHaveLength(1)
  })

  it('reports capability availability from the composed context', async () => {
    const absent = await bootCreation()
    expect(absent.harness.service.worktreeIsolationAvailable).toBe(false)
    const provided = await bootCreation({ worktrees: new FakeWorktreesCapability() })
    expect(provided.harness.service.worktreeIsolationAvailable).toBe(true)
  })

  it('detects a capability provided or disposed after the service loaded', async () => {
    const { harness } = await bootCreation()
    expect(harness.service.worktreeIsolationAvailable).toBe(false)
    const dispose = harness.ctx.provide('worktrees', new FakeWorktreesCapability())
    expect(harness.service.worktreeIsolationAvailable).toBe(true)
    dispose()
    expect(harness.service.worktreeIsolationAvailable).toBe(false)
  })

  it('does not admit the prompt when the call is cancelled during isolation', async () => {
    const worktrees = new FakeWorktreesCapability()
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)
    const cancellation = new AbortController()
    worktrees.createHandler = () => {
      cancellation.abort()
      return { ...FAKE_WORKTREE }
    }

    const failure = await harness.service
      .createSession(
        harness.lead.agent,
        { workspace: WORKSPACE_PATH, prompt: 'never admitted', isolation: 'worktree' },
        cancellation.signal,
      )
      .then(() => undefined, (error: unknown) => error)

    expect((failure as { name?: unknown } | undefined)?.name).toBe('AbortError')
    expect(worktrees.calls).toHaveLength(1)
    expect(liveChild(harness).followups).toHaveLength(0)
  })

  it('prefers cancellation over a worktree failure reported after the abort', async () => {
    const worktrees = new FakeWorktreesCapability()
    const { harness, controller } = await bootCreation({ worktrees })
    scriptCreateLiveSession(harness, controller)
    const cancellation = new AbortController()
    worktrees.createHandler = () => {
      cancellation.abort()
      throw new Error('git failed after the caller aborted')
    }
    const warn = vi.spyOn(harness.ctx.logger, 'warn')

    const failure = await harness.service
      .createSession(
        harness.lead.agent,
        { workspace: WORKSPACE_PATH, prompt: 'never admitted', isolation: 'worktree' },
        cancellation.signal,
      )
      .then(() => undefined, (error: unknown) => error)

    expect((failure as { name?: unknown } | undefined)?.name).toBe('AbortError')
    expect(worktrees.calls).toHaveLength(1)
    expect(liveChild(harness).followups).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('experimental dependency surface', () => {
  /** Repository root; this spec lives in packages/devlead/tests. */
  const packagesDir = fileURLToPath(new URL('../../../packages', import.meta.url))

  /** Every workspace package name, read without traversing node_modules. */
  async function packageNames(): Promise<string[]> {
    const entries = await readdir(packagesDir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  it('never references or injects the experimental package in any package source', async () => {
    let scanned = 0
    for (const packageName of await packageNames()) {
      const sourceDir = join(packagesDir, packageName, 'src')
      let entries: string[]
      try {
        entries = await readdir(sourceDir, { recursive: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
        const source = join(sourceDir, entry)
        const text = await readFile(source, 'utf8')
        scanned += 1
        expect(text, `${source} must not reference the experimental package`)
          .not.toContain('@deepseek-ai/dsh-experimental')
        expect(text, `${source} must not inject the worktrees capability`)
          .not.toMatch(/inject\s*=\s*\[[^\]]*['"]worktrees['"]/)
      }
    }
    expect(scanned).toBeGreaterThan(20)
  })

  it('keeps the capability out of every manifest and the bundle patch', async () => {
    const names = await packageNames()
    expect(names).toHaveLength(6)
    for (const packageName of names) {
      const manifest = join(packagesDir, packageName, 'package.json')
      const text = await readFile(manifest, 'utf8')
      expect(text, `${manifest} must not declare an experimental dependency`).not.toContain('dsh-experimental')
      expect(text, `${manifest} must not declare a worktrees service dependency`).not.toContain('"worktrees"')
    }
    const patch = await readFile(join(packagesDir, 'bundle', 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('dsh-experimental')
    const index = await readFile(join(packagesDir, 'devlead', 'src', 'index.ts'), 'utf8')
    expect(index).toContain("static inject = ['agents', 'sessions', 'sessionProjections']")
  })
})
