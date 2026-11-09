/**
 * Pure pending-call presentation for the `devlead_*` tools.
 *
 * `presentCall` runs on live streaming AND on session-log replay, so every
 * presenter here depends only on the parsed call arguments: no service reads,
 * no clock, no filesystem. The generic card only needs a title, a category, and
 * one salient input.
 *
 * @module @yankeguo/dsh-tool-devlead/presentation
 */

import type { GenericCallView, ToolCallKind } from '@deepseek-ai/dsh-tools'
import type {
  CreateSessionArgs,
  GetSessionArgs,
  ListSessionsArgs,
  NotificationsArgs,
  PromptSessionArgs,
  UseWorkspaceArgs,
  WatchSessionArgs,
} from './arguments.ts'

/**
 * Build one generic pending card.
 * @param title - short human label of the call.
 * @param kind - icon category of the call.
 * @param rawInput - salient input shown in the expanded card, when one exists.
 * @returns the card render intent.
 */
export function present(title: string, kind: ToolCallKind, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Pending card of `devlead_list_workspaces`. */
export function presentListWorkspacesCall(): GenericCallView {
  return present('List DevLead workspaces', 'search')
}

/** Pending card of `devlead_use_workspace`. */
export function presentUseWorkspaceCall(args: UseWorkspaceArgs): GenericCallView {
  return present('Register DevLead workspace', 'other', args.path)
}

/** Pending card of `devlead_list_sessions`. */
export function presentListSessionsCall(args: ListSessionsArgs): GenericCallView {
  return present('List DevLead sessions', 'search', args.workspace)
}

/** Pending card of `devlead_create_session`. */
export function presentCreateSessionCall(args: CreateSessionArgs): GenericCallView {
  return present('Create DevLead session', 'other', args.title ?? args.workspace)
}

/** Pending card of `devlead_get_session`. */
export function presentGetSessionCall(args: GetSessionArgs): GenericCallView {
  return present('Read DevLead session', 'read', args.session)
}

/** Pending card of `devlead_prompt_session`. */
export function presentPromptSessionCall(args: PromptSessionArgs): GenericCallView {
  return present('Prompt DevLead session', 'other', args.session)
}

/** Pending card of `devlead_watch_session`. */
export function presentWatchSessionCall(args: WatchSessionArgs): GenericCallView {
  const title = args.watching ? 'Watch DevLead session' : 'Unwatch DevLead session'
  return present(title, 'other', args.session)
}

/** Pending card of `devlead_notifications`. */
export function presentNotificationsCall(args: NotificationsArgs): GenericCallView {
  return present('Read DevLead notifications', 'read', args.limit)
}
