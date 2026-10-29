/**
 * Project one Agent's provider/model/reasoning selection through ACP session
 * configuration options.
 *
 * This is the answer to "where does the model list come from": the list is
 * `ctx.llm.listProviders()` fanned out over `ctx.llm.listModels(provider)`,
 * projected into one grouped `select` option. The catalog is advisory — the
 * exact route is validated with `ctx.llm.resolveCallConfig()`, and a selected
 * model missing from the catalog is injected into the list rather than hidden.
 *
 * Ported from `packages/acp/acp/src/model-control.ts`; the native class is not
 * reusable here because the standalone profile does not install @deepseek-ai/dsh-acp.
 *
 * @module dsh-acp-plus/model-control
 */

import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
import { type Model, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const MODEL_CONFIG_ID = 'model'
const REASONING_CONFIG_ID = 'reasoning_effort'
/** Disjoint opaque value for "let the provider pick", since effort ids are non-empty. */
const PROVIDER_DEFAULT_REASONING_VALUE = ''

interface ModelChoice {
  selection: ModelSelection
  value: SessionConfigValueId
}

interface ConfigState {
  choices: Map<SessionConfigValueId, ModelSelection>
  options: SessionConfigOption[]
}

/** Caller-correctable session configuration failure. */
export class AcpPlusModelConfigError extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message: string) {
    super(message)
    this.name = 'AcpPlusModelConfigError'
  }
}

/**
 * Project and mutate one Agent's provider/model/reasoning selection through ACP
 * config options. The Session's recorded model selection is the only state; a
 * change applies from the Agent's next model step.
 */
export class AcpPlusModelControl {
  private tail = Promise.resolve()
  private hasResolvedState = false

  /**
   * @param llm - live LLM runtime supplying the provider/model catalog.
   * @param model - Agent-owned selection read and recorded through this view.
   */
  constructor(
    private readonly llm: LlmRuntime,
    private readonly model: Model,
  ) {}

  /**
   * Return the complete standard config-option state after prior mutations settle.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  options(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => (await this.state(signal)).options)
  }

  /**
   * Set one advertised option and return the complete resulting option state.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  set(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => {
      if (typeof value !== 'string') throw new AcpPlusModelConfigError(`${configId} requires a select value`)
      const current = this.model.current()
      if (current === undefined) throw new AcpPlusModelConfigError('this session has no model selection')
      if (configId === MODEL_CONFIG_ID) {
        const state = await this.state(signal)
        const selected = state.choices.get(value)
        if (selected === undefined) throw new AcpPlusModelConfigError(`unknown model option: ${value}`)
        await this.resolveSelection(selected, signal)
        this.model.select(selected)
      } else if (configId === REASONING_CONFIG_ID) {
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE
          && info.reasoning?.defaultEffort === undefined
        if (
          info.reasoning === undefined
          || (!providerDefault && !info.reasoning.efforts.some(effort => effort.id === value))
        ) {
          throw new AcpPlusModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`)
        }
        this.model.select(await this.resolveSelection({
          provider: current.provider,
          model: current.model,
          ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) },
        }, signal))
      } else {
        throw new AcpPlusModelConfigError(`unknown session config option: ${configId}`)
      }
      return (await this.state(signal)).options
    })
  }

  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Build detached model choices and the dependent reasoning option. */
  private async state(signal?: AbortSignal): Promise<ConfigState> {
    const selected = this.model.current()
    if (selected === undefined) return { choices: new Map(), options: [] }
    let resolved: ModelSelection
    let routeAvailable = true
    try {
      resolved = await this.resolveSelection(selected, signal)
      this.hasResolvedState = true
    } catch (error: unknown) {
      if (!this.hasResolvedState) throw error
      resolved = selected
      routeAvailable = false
    }
    const choices = new Map<SessionConfigValueId, ModelSelection>()
    const groups = await Promise.all(this.llm.listProviders().map(async (provider) => {
      try {
        const models = await this.llm.listModels(provider.id)
        const entries = models.map((model) => {
          const choice: ModelChoice = {
            value: modelValue(provider.id, model.id),
            selection: { provider: provider.id, model: model.id },
          }
          choices.set(choice.value, choice.selection)
          return {
            value: choice.value,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
          }
        })
        return { group: provider.id, name: provider.name, options: entries }
      } catch (_providerCatalogUnavailable) {
        // One provider's catalog failing must not fail the whole option state.
        return { group: provider.id, name: provider.name, options: [] }
      }
    }))
    const currentValue = modelValue(resolved.provider, resolved.model)
    if (!choices.has(currentValue)) {
      choices.set(currentValue, { provider: resolved.provider, model: resolved.model })
      let group = groups.find(item => item.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    const options: SessionConfigOption[] = [{
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: groups.filter(group => group.options.length > 0),
    }]
    const info = routeAvailable
      ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      : undefined
    if (info?.reasoning !== undefined) {
      options.push({
        id: REASONING_CONFIG_ID,
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: resolved.reasoningEffort === undefined
          ? PROVIDER_DEFAULT_REASONING_VALUE
          : String(resolved.reasoningEffort),
        options: [
          ...info.reasoning.defaultEffort === undefined
            ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
            : [],
          ...info.reasoning.efforts.map(effort => ({
            value: String(effort.id),
            name: effort.name,
            ...effort.description === undefined ? {} : { description: effort.description },
          })),
        ],
      })
    }
    return { choices, options }
  }

  /** Validate an exact route and retain only Agent-owned selection fields. */
  private async resolveSelection(selection: ModelSelection, signal?: AbortSignal): Promise<ModelSelection> {
    const resolved: LlmCallConfig = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
  }
}

/** Opaque ACP selector value carrying the full route identity. */
function modelValue(provider: string, model: string): SessionConfigValueId {
  return JSON.stringify([provider, model])
}
