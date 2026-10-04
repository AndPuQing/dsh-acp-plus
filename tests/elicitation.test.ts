/**
 * Elicitation over ACP (PLAN.md M5): `ask_user_question` reaches the client's
 * form when the client declared form support, remains unavailable otherwise,
 * and settles when the human declines or the question is withdrawn.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import {
  buildFormRequest,
  mapFormAnswer,
  type AcpElicitationFormParams,
} from '../src/features/elicitation.ts'
import { makeBridgeHarness, textResponse, toolCallResponse, waitFor } from './harness.ts'

const CWD = process.cwd()
const SESSION = brandString<SessionId>('session-1')

/** One ask_user_question script entry used by the e2e cases. */
function askScript(): ReturnType<typeof toolCallResponse> {
  return toolCallResponse('ask_user_question', 'call-ask', {
    questions: [{
      id: 'choice',
      question: 'Which option should I use?',
      header: 'Choose',
      options: [
        { label: 'Alpha', description: 'The first option.' },
        { label: 'Beta' },
      ],
    }],
  })
}

const DSH_REQUEST: AskUserQuestionRequest = {
  questions: [
      {
        id: 'single',
        question: 'Pick one',
        header: 'Choice',
        options: [{ label: 'A', description: 'First.' }, { label: 'B' }],
      },
      { id: 'multi', question: 'Pick many', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
      { id: 'free', question: 'Anything else?', detail: 'Optional detail.' },
  ],
}

test('builds one form field per question with an optional free-text answer', () => {
  const request = buildFormRequest(SESSION, DSH_REQUEST)

  assert.equal(request.mode, 'form')
  assert.equal(request.sessionId, SESSION)
  assert.equal(request.message, 'Pick one\n\nPick many\n\nAnything else?')
  const properties = request.requestedSchema.properties
  assert.deepEqual(properties?.['single'], {
    type: 'string',
    title: 'Choice',
    description: 'Pick one',
    oneOf: [
      { const: 'A', title: 'A', description: 'First.' },
      { const: 'B', title: 'B' },
    ],
  })
  assert.deepEqual(properties?.['single__other'], {
    type: 'string',
    title: 'Other (optional)',
    description: 'Free-text answer instead of the listed choices.',
  })
  assert.deepEqual(properties?.['multi'], {
    type: 'array',
    title: 'Pick many',
    items: { type: 'string', enum: ['X', 'Y'] },
  })
  assert.deepEqual(properties?.['free'], {
    type: 'string',
    title: 'Anything else?',
    description: 'Optional detail.',
  })
})

test('maps accepted form content back to structured answers', () => {
  const questions: AskUserQuestionRequest = {
    questions: [
      { id: 'single', question: 'Pick one', options: [{ label: 'A' }] },
      { id: 'multi', question: 'Pick many', options: [{ label: 'X' }], multiSelect: true },
      { id: 'free', question: 'Anything?' },
    ],
  }

  assert.deepEqual(mapFormAnswer(questions, {
    action: 'accept',
    content: {
      single: 'A',
      single__other: '  typed instead  ',
      multi: ['X'],
      free: 'hello',
    } as never,
  }), {
    answers: [
      { id: 'single', selected: ['A'], custom: 'typed instead' },
      { id: 'multi', selected: ['X'] },
      { id: 'free', selected: ['hello'] },
    ],
  })

  assert.throws(() => mapFormAnswer(questions, { action: 'decline' }), /declined/)
  assert.throws(() => mapFormAnswer(questions, { action: 'cancel' }), /cancelled/)
})

test('reaches the client form for a declared, capable client', async () => {
  const harness = await makeBridgeHarness({
    userQuestions: true,
    script: [askScript(), textResponse('done')],
  })
  try {
    harness.elicitation.behavior.content = { choice: 'Alpha' }
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.elicitation.requests.length, 1)
    const request = harness.elicitation.requests[0]
    assert.equal(request?.mode, 'form')
    const form = request as AcpElicitationFormParams
    assert.equal(form.sessionId, created.sessionId)
    assert.equal(form.message, 'Which option should I use?')
    const completed = harness.updates.find(update =>
      update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    assert.ok(completed !== undefined)
    const text = (completed as { content: Array<{ content: { text: string } }> }).content[0]?.content.text
    assert.deepEqual(JSON.parse(text ?? '{}'), { answers: [{ id: 'choice', selected: ['Alpha'] }] })
  } finally {
    await harness.dispose()
  }
})

test('keeps asking unavailable when the client did not declare form support', async () => {
  const harness = await makeBridgeHarness({
    userQuestions: true,
    script: [askScript(), textResponse('done')],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.elicitation.requests.length, 0)
    assert.ok(harness.updates.some(update =>
      update.sessionUpdate === 'tool_call_update' && update.status === 'failed'))
  } finally {
    await harness.dispose()
  }
})

test('settles as a tool failure when the human declines', async () => {
  const harness = await makeBridgeHarness({
    userQuestions: true,
    script: [askScript(), textResponse('done')],
  })
  try {
    harness.elicitation.behavior.action = 'decline'
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    const failed = harness.updates.find(update =>
      update.sessionUpdate === 'tool_call_update' && update.status === 'failed')
    assert.match(JSON.stringify(failed), /declined to answer/)
  } finally {
    await harness.dispose()
  }
})

test('a withdrawn question settles the cancelled turn instead of hanging', async () => {
  const harness = await makeBridgeHarness({
    userQuestions: true,
    elicitation: { hang: true },
    script: [askScript()],
  })
  try {
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me' }],
    })
    await waitFor(() => harness.elicitation.requests.length === 1)

    await harness.client.cancel({ sessionId: created.sessionId })
    const result = await prompt

    assert.equal(result.stopReason, 'cancelled')
  } finally {
    await harness.dispose()
  }
})
