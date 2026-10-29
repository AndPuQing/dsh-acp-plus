/**
 * Standard model/reasoning config-option projection (PLAN.md M0–M1).
 *
 * Behavior ported from `packages/acp/acp/tests/model-control.spec.ts`: the
 * catalog is advisory, the exact route is validated before publication, and a
 * pinned turn owns the route until its own `turn/end`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpPlusModelControl } from '../src/model-control.ts'

type Selection = { provider?: string; model?: string; reasoningEffort?: string }

/** Agent-owned model double: a recorded selection is the only state. */
class FakeModel implements Model {
  private selection: ModelSelection | undefined

  constructor(initial?: ModelSelection) {
    this.selection = initial
  }

  current(): Readonly<ModelSelection> | undefined {
    return this.selection === undefined ? undefined : { ...this.selection }
  }

  select(selection: Readonly<ModelSelection>): void {
    this.selection = { ...selection }
  }
}

/** Minimal LLM catalog/runtime double for pure standard-option tests. */
function llmRuntime(overrides: Partial<LlmRuntime> = {}): LlmRuntime {
  return {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: () => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]),
    resolveCallConfig: (selection: Selection) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? { reasoningEffort: ReasoningEffortId('high') }
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low', description: 'Less thought.' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }),
    ...overrides,
  } as unknown as LlmRuntime
}

test('represents an absent route and validates value types before mutation', async () => {
  const model = new FakeModel()
  const control = new AcpPlusModelControl(llmRuntime(), model)

  assert.equal(model.current(), undefined)
  assert.deepEqual(await control.options(), [])
  await assert.rejects(control.set('model', false), /requires a select value/)
  await assert.rejects(control.set('model', 'missing'), /no model selection/)
})

test('synthesizes an unlisted current route and exposes reasoning descriptions', async () => {
  const agentModel = new FakeModel({ provider: 'private', model: 'unlisted' })
  const control = new AcpPlusModelControl(llmRuntime({ listProviders: () => [] }), agentModel)

  const options = await control.options()
  const model = options.find(option => option.id === 'model')
  const reasoning = options.find(option => option.id === 'reasoning_effort')
  assert.deepEqual(model, {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["private","unlisted"]',
    options: [{ group: 'private', name: 'private', options: [{ value: '["private","unlisted"]', name: 'unlisted' }] }],
  })
  assert.deepEqual(reasoning, {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low', description: 'Less thought.' },
      { value: 'high', name: 'High' },
    ],
  })

  // The projection reads the Agent's live selection on every state read.
  agentModel.select({ provider: 'private', model: 'switched' })
  const switched = (await control.options()).find(option => option.id === 'model')
  assert.equal(switched?.currentValue, '["private","switched"]')
})

test('keeps the selected route when its provider catalog is temporarily unavailable', async () => {
  let listed = 0
  const control = new AcpPlusModelControl(llmRuntime({
    listModels: () => { listed += 1; return Promise.reject(new Error('catalog unavailable')) },
  }), new FakeModel({ provider: 'mock', model: 'mock' }))

  const options = await control.options()

  assert.equal(listed, 1)
  assert.deepEqual(options[0], {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["mock","mock"]',
    options: [{ group: 'mock', name: 'Mock', options: [{ value: '["mock","mock"]', name: 'mock' }] }],
  })
})

test('rejects an unadvertised reasoning effort and accepts a later valid change', async () => {
  const control = new AcpPlusModelControl(llmRuntime(), new FakeModel({ provider: 'mock', model: 'mock' }))

  await assert.rejects(control.set('reasoning_effort', 'extreme'), /unknown reasoning effort/)
  const options = await control.set('reasoning_effort', 'low')

  assert.equal(options.find(option => option.id === 'reasoning_effort')?.currentValue, 'low')
})

test('exposes and restores a provider-owned reasoning default', async () => {
  const runtime = llmRuntime({
    resolveCallConfig: (selection: Selection) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      },
    }),
  })
  const model = new FakeModel({ provider: 'mock', model: 'mock' })
  const control = new AcpPlusModelControl(runtime, model)

  const initial = await control.options()
  assert.deepEqual(initial.find(option => option.id === 'reasoning_effort'), {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: '',
    options: [
      { value: '', name: 'Provider default' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  })
  await control.set('reasoning_effort', 'low')
  const restored = await control.set('reasoning_effort', '')

  assert.equal(restored.find(option => option.id === 'reasoning_effort')?.currentValue, '')
  assert.deepEqual(model.current(), { provider: 'mock', model: 'mock' })
})
