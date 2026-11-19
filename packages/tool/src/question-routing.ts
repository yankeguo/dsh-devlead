/**
 * Route direct user questions from watched Sessions to their active DevLead.
 *
 * A watched Session is a real Session, but the human-facing `ask_user_question`
 * tool belongs to the child's own conversation surface. When the child is
 * watched by an active DevLead, that path would bypass the lead, so this module
 * installs a hard `tools/pre-execute` gate: the question is formatted into a
 * durable `kind: question` report for the lead and the tool call is denied with
 * explicit "end your turn and wait" guidance. The lead answers with
 * `devlead_prompt_session` (or asks the human itself and relays the answer).
 *
 * The gate deliberately exempts two cases:
 *
 * - an unwatched Session (nothing to bypass), and
 * - a turn whose latest actionable user message came directly from the human
 *   (`source.kind === 'user'`); a human talking in the child is already the
 *   decision-maker and may answer the child's question in place.
 *
 * A child can still end its turn with a natural-language question; there is no
 * reliable tool-level hook for prose, so the normal watched-turn notification's
 * assistant excerpt is the fallback path for that case.
 *
 * @module @yankeguo/dsh-tool-devlead/question-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { DevLeadService } from '@yankeguo/dsh-devlead'
import {
  DEVLEAD_MESSAGE_KIND,
  DEVLEAD_QUESTIONS_MAX,
  DEVLEAD_QUESTION_FIELD_MAX,
  DEVLEAD_QUESTION_OPTIONS_MAX,
  DEVLEAD_REPORT_MESSAGE_MAX,
  DEVLEAD_REPORT_SUMMARY_MAX,
} from '@yankeguo/dsh-devlead-protocol'
import type { DevLeadQuestion, DevLeadQuestionOption } from '@yankeguo/dsh-devlead-protocol'

/** Exact tool name the Host's user-question surface registers. */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/**
 * Source kinds that record a human action in the child's current turn.
 * `user-question-reply` follows the human answering an earlier question and
 * `user-approval` follows a human approval/policy decision; both mean the
 * human is present and may answer the next question in place.
 */
const HUMAN_SOURCE_KINDS = new Set(['user', 'user-question-reply', 'user-approval'])

/** Source kinds that are injected context rather than an actionable prompt. */
const NON_ACTIONABLE_SOURCE_KINDS = new Set([
  'runtime-context',
  'tool-registry',
  'time-context',
  'tmux-context',
  'agent-instructions',
  'working-directory',
  'ptc-mode',
  'plan-mode',
  'session-reference',
  'action-cards',
  'webhook',
])

/** Prefixes of plugin-injected context sources (`hooks-claude-code`, `hooks-codex`, …). */
const NON_ACTIONABLE_SOURCE_PREFIXES = ['hooks-']

/**
 * Context forms that identify an injected message even when its producer kind
 * is new to this build: instructions, catalogs, runtime snapshots, notices,
 * recalled references, and relayed context are not prompts from a human.
 */
const NON_ACTIONABLE_SOURCE_FORMS = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
  'recall',
  'relay',
])

/** Denial after the question report was durably handed to the lead. */
const FORWARDED_REASON = 'Direct user questions are disabled while this Session is watched by a DevLead. '
  + 'The question was forwarded to the DevLead as a question report; end your turn now and wait for the '
  + 'DevLead to answer in a new turn. Do not call ask_user_question again or poll for the answer.'

/** Denial when forwarding itself failed. */
const FORWARD_FAILED_REASON = 'Direct user questions are disabled while this Session is watched by a DevLead, '
  + 'and forwarding the question failed. End your turn now and state the question in your final assistant '
  + 'message so the DevLead can read it from the turn notification. Do not call ask_user_question again.'

/** Denial when the payload cannot be read well enough to forward. */
const UNREADABLE_REASON = 'Direct user questions are disabled while this Session is watched by a DevLead, '
  + 'and the question payload could not be read to forward it. End your turn now and state the question in '
  + 'your final assistant message so the DevLead can read it from the turn notification. Do not call '
  + 'ask_user_question again.'

/** One question batch formatted as the lead-facing report. */
export interface QuestionReport {
  /** Full report text, bounded by {@link DEVLEAD_REPORT_MESSAGE_MAX}. */
  readonly message: string
  /** Short digest title, bounded by {@link DEVLEAD_REPORT_SUMMARY_MAX}. */
  readonly summary: string
  /** Detached, bounded native payload persisted alongside the text. */
  readonly questions: readonly DevLeadQuestion[]
}

/** Narrow an unknown value to a non-array object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Bound one string by Unicode code points, preserving a complete prefix. */
function truncate(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`
}

/** Recover a human-readable message from a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * Format one `ask_user_question` argument payload as the report the lead reads.
 *
 * The tool schema owns validation; this formatter only extracts the stable
 * fields and degrades to a compact unreadable-payload path in the gate rather
 * than letting an unexpected shape reach the child's own user-question UI.
 * @param args - parsed `ask_user_question` arguments.
 * @returns the report text and summary, or undefined when no question is readable.
 */
export function formatQuestionReport(args: unknown): QuestionReport | undefined {
  const questions = asRecord(args)?.questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const lines: string[] = []
  const structured: DevLeadQuestion[] = []
  let firstSummary: string | undefined
  for (const entry of questions) {
    const question = asRecord(entry)
    if (question === undefined) continue
    const text = typeof question.question === 'string' ? question.question.trim() : ''
    if (text.length === 0) continue
    const id = typeof question.id === 'string' ? question.id.trim() : ''
    const header = typeof question.header === 'string' ? question.header.trim() : ''
    firstSummary ??= header.length > 0 ? header : text
    lines.push(`- ${id.length === 0 ? '' : `[${id}] `}${header.length === 0 ? '' : `${header}: `}${text}`)
    const options: DevLeadQuestionOption[] = []
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        const optionRecord = asRecord(option)
        if (optionRecord === undefined) continue
        const label = typeof optionRecord.label === 'string' ? optionRecord.label.trim() : ''
        if (label.length === 0) continue
        const description = typeof optionRecord.description === 'string'
          ? optionRecord.description.trim()
          : ''
        lines.push(`  - ${label}${description.length === 0 ? '' : ` — ${description}`}`)
        if (options.length < DEVLEAD_QUESTION_OPTIONS_MAX) {
          options.push({
            label: truncate(label, DEVLEAD_QUESTION_FIELD_MAX),
            ...(description.length === 0 ? {} : {
              description: truncate(description, DEVLEAD_QUESTION_FIELD_MAX),
            }),
          })
        }
      }
    }
    if (question.multi_select === true) lines.push('  (multi-select)')
    if (structured.length < DEVLEAD_QUESTIONS_MAX) {
      structured.push({
        ...(id.length === 0 ? {} : { id: truncate(id, DEVLEAD_QUESTION_FIELD_MAX) }),
        ...(header.length === 0 ? {} : { header: truncate(header, DEVLEAD_QUESTION_FIELD_MAX) }),
        question: truncate(text, DEVLEAD_QUESTION_FIELD_MAX),
        ...(Array.isArray(question.options) ? { options } : {}),
        ...(typeof question.multi_select === 'boolean' ? { multi_select: question.multi_select } : {}),
      })
    }
  }
  if (lines.length === 0 || firstSummary === undefined) return undefined
  return {
    message: truncate(
      'The watched Session asked a question; an answer is requested. Reply with devlead_prompt_session:\n'
      + lines.join('\n'),
      DEVLEAD_REPORT_MESSAGE_MAX,
    ),
    summary: truncate(`Question: ${firstSummary}`, DEVLEAD_REPORT_SUMMARY_MAX),
    questions: structured,
  }
}

/**
 * Whether the Agent's current turn was opened or steered directly by a human.
 *
 * The event log records the source of every user message. Only a human source
 * (`user`, `user-question-reply`, `user-approval`) makes the turn human-directed;
 * a DevLead relay is lead-directed. Known context injections and any source
 * carrying a context form are skipped, so an injected timestamp/instructions
 * notice does not erase the human who opened the turn. An unknown source kind
 * stops the scan as lead-directed instead of guessing that a human is present.
 * If no actionable prompt is visible, the gate routes the question to the lead.
 * @param agent - child Agent whose current turn is being inspected.
 * @returns whether the latest actionable user message came from a human.
 */
export function isHumanDirectedTurn(agent: Agent): boolean {
  const events = agent.session.snapshotEvents()
  let turnStart = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      turnStart = index
      break
    }
  }
  if (turnStart < 0) return false
  for (let index = events.length - 1; index > turnStart; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: unknown; form?: unknown } } | undefined)?.source
    const kind = source?.kind
    if (typeof kind !== 'string') return false
    if (kind === DEVLEAD_MESSAGE_KIND) return false
    if (NON_ACTIONABLE_SOURCE_KINDS.has(kind)
      || NON_ACTIONABLE_SOURCE_PREFIXES.some(prefix => kind.startsWith(prefix))) continue
    const form = source?.form
    if (typeof form === 'string' && NON_ACTIONABLE_SOURCE_FORMS.has(form)) continue
    if (HUMAN_SOURCE_KINDS.has(kind)) return true
    return false
  }
  return false
}

/**
 * Install the watched-Session question gate on the tool pipeline.
 *
 * The listener is root-scoped and checks the calling Agent, so it sees every
 * Agent's `ask_user_question` call. A watched child's question is formatted,
 * forwarded through `reportProgress({ kind: 'question' })` (durable and waking
 * for the lead), and denied before the child's own question UI can run. The
 * lead answers asynchronously through `devlead_prompt_session`; the child's
 * turn is expected to end rather than hold a pending tool call.
 * @param ctx - plugin context carrying the tool pipeline and logger.
 * @param devLead - DevLead service used to test supervision and deliver the report.
 */
export function registerQuestionRouting(ctx: Context, devLead: DevLeadService): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== ASK_USER_QUESTION_TOOL || exec.agent === undefined) return next()
    if (!devLead.isSupervised(exec.agent)) return next()
    if (isHumanDirectedTurn(exec.agent)) return next()
    const question = formatQuestionReport(exec.arguments)
    if (question === undefined) return { kind: 'deny', reason: UNREADABLE_REASON }
    try {
      await devLead.reportProgress(exec.agent, {
        kind: 'question',
        message: question.message,
        summary: question.summary,
        questions: question.questions,
      }, exec.signal)
    } catch (error: unknown) {
      ctx.logger.warn(
        `devlead: could not forward a watched Session's question to its lead: ${messageOf(error)}`,
      )
      return { kind: 'deny', reason: FORWARD_FAILED_REASON }
    }
    return { kind: 'deny', reason: FORWARDED_REASON }
  })
}