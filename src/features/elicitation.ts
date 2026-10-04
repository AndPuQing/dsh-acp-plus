/**
 * Elicitation: route `ask_user_question` and other `ctx.userQuestions` asks to
 * the ACP client's form elicitation instead of failing with "no answerer".
 *
 * Mechanism:
 * - Register one `user-questions/request` waterfall listener for the bridge's
 *   own agents; every other agent calls `next()` and keeps the normal chain.
 * - Translate the DSH question set into one ACP `elicitation/create` form:
 *   option questions become titled single-selects or string arrays, free-form
 *   questions become strings, and each option question gains an optional
 *   free-text field so the human can answer outside the offered labels.
 * - A decline/cancel settles the tool as an error, and an aborted question
 *   settles immediately instead of waiting for a peer that will never answer
 *   (the SDK settles cancelled requests only when the peer responds).
 *
 * Milestone: M5 in PLAN.md.
 *
 * @module dsh-acp-plus/features/elicitation
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/** Suffix marking a question's optional free-text field. */
const OTHER_SUFFIX = '__other'

/** The concrete form-mode elicitation request this module builds. */
export interface AcpElicitationFormParams {
  /** Session the elicitation belongs to. */
  sessionId: SessionId
  /** Form mode discriminator. */
  mode: 'form'
  /** Human-readable prompt shown above the form. */
  message: string
  /** Form field schema. */
  requestedSchema: ElicitationSchema
}

/** The one client operation this feature consumes. */
export interface AcpElicitationHost {
  /** Ask the client to present one form and return the human's response. */
  create(params: CreateElicitationRequest, signal?: AbortSignal): Promise<CreateElicitationResponse>
}

/** Build the ACP form field for one question's option list. */
function choiceField(question: AskUserQuestionItem): ElicitationPropertySchema {
  const options = question.options ?? []
  const title = question.header ?? question.question
  const description = question.header === undefined ? question.detail : question.question
  const base = {
    title,
    ...description === undefined ? {} : { description },
  }
  return question.multiSelect === true
    ? {
      type: 'array',
      ...base,
      items: { type: 'string', enum: options.map(option => option.label) },
    }
    : {
      type: 'string',
      ...base,
      oneOf: options.map(option => ({
        const: option.label,
        title: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    }
}

/**
 * Translate one DSH question set into a single ACP form request.
 * @param sessionId - ACP session the elicitation belongs to.
 * @param request - questions, owner, and cancellation signal.
 * @returns the form-mode elicitation request.
 */
export function buildFormRequest(
  sessionId: SessionId,
  request: AskUserQuestionRequest,
): AcpElicitationFormParams {
  const properties: Record<string, ElicitationPropertySchema> = {}
  for (const question of request.questions) {
    const options = question.options ?? []
    if (options.length === 0) {
      properties[question.id] = {
        type: 'string',
        title: question.header ?? question.question,
        ...question.detail === undefined ? {} : { description: question.detail },
      }
      continue
    }
    properties[question.id] = choiceField(question)
    properties[`${question.id}${OTHER_SUFFIX}`] = {
      type: 'string',
      title: 'Other (optional)',
      description: 'Free-text answer instead of the listed choices.',
    }
  }
  return {
    sessionId,
    mode: 'form',
    message: request.questions.map(question => question.question).join('\n\n'),
    requestedSchema: { type: 'object', properties },
  }
}

/** Narrow one accepted form value to the answer item it encodes. */
function answerItem(question: AskUserQuestionItem, content: Record<string, unknown>): AskUserQuestionAnswer['answers'][number] {
  const value = content[question.id]
  const selected = question.multiSelect === true
    ? Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    : typeof value === 'string' && value.length > 0 ? [value] : []
  const other = content[`${question.id}${OTHER_SUFFIX}`]
  const custom = typeof other === 'string' ? other.trim() : ''
  return {
    id: question.id,
    selected,
    ...custom.length === 0 ? {} : { custom },
  }
}

/**
 * Convert one client response into the DSH answer contract.
 * @param request - the questions that were presented.
 * @param response - the client's elicitation response.
 * @returns structured answers in question order.
 * @throws when the human declined or cancelled instead of answering.
 */
export function mapFormAnswer(
  request: AskUserQuestionRequest,
  response: CreateElicitationResponse,
): AskUserQuestionAnswer {
  if (response.action !== 'accept') {
    throw new Error(response.action === 'decline'
      ? 'The user declined to answer the question.'
      : 'The user cancelled the question.')
  }
  const content = (response.content ?? {}) as Record<string, unknown>
  return { answers: request.questions.map(question => answerItem(question, content)) }
}

/** Reject as soon as the question is withdrawn, regardless of the peer. */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason ?? new Error('the question was withdrawn')) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Ask the ACP client one question set and map its response.
 * @param host - connection-backed elicitation operation.
 * @param sessionId - ACP session the elicitation belongs to.
 * @param request - questions, owner, and cancellation signal.
 * @returns the human's structured answer.
 */
export async function answerWithElicitation(
  host: AcpElicitationHost,
  sessionId: SessionId,
  request: AskUserQuestionRequest,
): Promise<AskUserQuestionAnswer> {
  const response = await raceAbort(host.create(buildFormRequest(sessionId, request), request.signal), request.signal)
  return mapFormAnswer(request, response)
}
