/**
 * One standard ACP session's Agent, configuration, prompt, update, and teardown
 * lifecycle.
 *
 * Shape and semantics ported from `packages/acp/acp/src/session.ts`: admission
 * validates and cancels before queueing, settlement waits for whole-Agent
 * quiescence, and teardown drains the ordered output tail. The only intentional
 * omission is `session/resume` (PLAN.md M2).
 *
 * @module dsh-acp-plus/sessions
 */

import {
  RequestError,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, errorChain, type UserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpPlusContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { preApprovedEscalation, registerAdditionalDirectoriesContext } from './features/additional-directories.ts'
import {
  availableCommands,
  commandDoneUpdate,
  commandRunUpdate,
  parseSlashCommand,
  promptCommandLine,
} from './features/commands.ts'
import { DEFAULT_MODE_ID, PLAN_MODE_ID, sessionModeState, setSessionMode } from './features/modes.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpPlusModelControl } from './model-control.ts'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/** The continuable-subagent teardown used without depending on the subagent package. */
interface ContinuableDrain {
  /** Dispose continuable descendants below exact host-owned parents child-first. */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpPlusSessionBuildOptions {
  /** Absolute workspace the client asked for. */
  cwd: string
  /** Standard MCP server declarations to mount before publication. */
  mcpServers: readonly McpServer[]
  /** Authorized additional workspace roots from the lifecycle request. */
  additionalDirectories: readonly string[]
  /** Per-agent route options from deployment config. */
  agentOptions: AgentOptions
  /** Deployment provider/model selection, or undefined when a listener supplies it. */
  fallbackSelection: ModelSelection | undefined
  /** JSON-RPC request cancellation. */
  signal: AbortSignal
  /** Ordered update delivery owned by the bridge. */
  notify: (notification: SessionNotification) => Promise<void>
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpPlusSessionOptions extends AcpPlusSessionBuildOptions {
  /** Fresh session identity minted for `session/new`. */
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpPlusSessionOptions extends AcpPlusSessionBuildOptions {
  /** Persisted session identity restored from storage. */
  sessionId: SessionId
}

/** One in-flight prompt and the state its settlement depends on. */
interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancelRequested: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Restore the latest logged route before falling back to deployment config. */
function selectionFor(
  logged: {
    config: { provider: string; model: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
    adapterDefaults?: { reasoningEffort?: boolean }
  } | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  return logged === undefined
    ? fallback
    : {
      provider: logged.config.provider,
      model: logged.config.model,
      ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: logged.config.reasoningEffort },
    }
}

/** Parse one committed tool call's model-supplied arguments without failing the bridge. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return undefined
  }
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered standard updates, and memoized
 * quiescent teardown.
 */
export class AcpPlusSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpPlusModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  /** Current slash-command execution, aborted by session cancellation or close. */
  private commandAbort: AbortController | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()
  /** Model-supplied arguments of in-flight tool calls, for escalation checks. */
  private readonly toolCalls = new Map<string, { name: string; arguments: unknown }>()
  /** Client-declared additional workspace roots, canonical and deduplicated. */
  private readonly additionalDirectories: readonly string[]

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    modelControl: AcpPlusModelControl,
    additionalDirectories: readonly string[],
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent
    this.modelControl = modelControl
    this.additionalDirectories = additionalDirectories
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - plugin context carrying the agent factory, LLM, and persistence.
   * @param options - fresh identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpPlusSessionOptions): Promise<AcpPlusSession> {
    const modelControl = new AcpPlusModelControl(ctx.llm, options.fallbackSelection)
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        // The declaration is a session-level grant; the sandbox stays at its
        // standing mode and reach is realized per call through escalation.
        registerAdditionalDirectoriesContext(agentCtx, options.additionalDirectories)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpPlusSession(ctx, handle, modelControl, options.additionalDirectories, options.notify)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * @param ctx - plugin context carrying the agent factory, LLM, and persistence.
   * @param options - persisted identity, workspace, fallback route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpPlusSessionOptions): Promise<AcpPlusSession> {
    let modelControl: AcpPlusModelControl | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpPlusModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection),
        )
        modelControl.install(agentCtx)
        registerAdditionalDirectoriesContext(agentCtx, options.additionalDirectories)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    if (modelControl === undefined) {
      await handle.dispose()
      throw internalError('session/resume did not compose model selection')
    }
    return new AcpPlusSession(ctx, handle, modelControl, options.additionalDirectories, options.notify)
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns every advertised configuration option.
   */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * Apply one standard configuration option to later ACP turns.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** Publish the current command list to this session's client. */
  publishCommands(): void {
    if (this.ctx.get('commands') === undefined) return
    const availableCommandsForAgent = availableCommands(this.ctx, this.agent)
    this.enqueue(() => this.notify({
      sessionId: this.agent.session.id,
      update: { sessionUpdate: 'available_commands_update', availableCommands: availableCommandsForAgent },
    }))
  }

  /**
   * Read the complete ACP mode state for this session.
   * @returns current mode id plus every mode this deployment offers, or undefined.
   */
  modeState(): SessionModeState | undefined {
    return sessionModeState(this.ctx, this.agent.session)
  }

  /**
   * Apply one requested ACP mode to this session's agent.
   * @param modeId - requested ACP mode id.
   */
  setMode(modeId: string): void {
    this.assertActive()
    setSessionMode(this.ctx, this.agent, modeId)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        this.enqueue(() => this.notify({
          sessionId: this.agent.session.id,
          update: { sessionUpdate: 'config_option_update', configOptions },
        }))
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp-plus: config-option update failed: ${errorChain(error)}`)
      })
  }

  /**
   * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive()
    // A slash line naming a registered command is a command invocation, not a
    // model turn; it stays available while a model turn is in flight, matching
    // the harness's own UI semantics.
    const commandLine = promptCommandLine(params.prompt)
    if (commandLine !== undefined) {
      const command = await parseSlashCommand(commandLine)
      if (command !== undefined && this.ctx.get('commands')?.find(this.agent, command.name) !== undefined) {
        return this.executeCommand(command.line, requestSignal)
      }
    }
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.cancelRequested) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpPlusContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
    this.commandAbort?.abort(new Error('ACP session cancelled'))
  }

  /**
   * Inject one client steer into the live turn at its next step boundary.
   * @param text - steering text already validated by the feature module.
   * @returns true when a live ACP prompt consumed it; false when the session
   *   is idle, cancelling, or otherwise not running, so the caller answers
   *   `promptRequired` instead of waking an untracked turn.
   */
  steer(text: string): boolean {
    const inflight = this.inflight
    if (inflight === undefined || inflight.cancelRequested || this.agent.status !== 'running') return false
    this.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    return true
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    // Record arguments before the async projection queue so a subsequent
    // approval ask for the same call sees them.
    if (event.type === 'tool/call') {
      this.toolCalls.set(String(event.data.callId), {
        name: event.data.name,
        arguments: parseToolArguments(event.data.arguments),
      })
    } else if (event.type === 'tool/result') {
      this.toolCalls.delete(String(event.data.message.toolCallId))
    }
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp-plus: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
      } else if (event.type === 'tool/result') {
        this.enqueue(async () => this.notify({
          sessionId: this.agent.session.id,
          update: await toolResultUpdate(this.ctx, event),
        }))
      } else if (event.type === 'command/run') {
        this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update: commandRunUpdate(event) }))
      } else if (event.type === 'command/done') {
        const update = commandDoneUpdate(event)
        if (update !== undefined) {
          this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update }))
        }
      } else if (event.type === 'plan/mode') {
        this.enqueue(() => this.notify({
          sessionId: this.agent.session.id,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: event.data.active ? PLAN_MODE_ID : DEFAULT_MODE_ID,
          },
        }))
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
      if (event.type === 'turn/end') this.modelControl.releaseTurn(event.data.turn)
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn and pinned route.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id)
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param turn - failed turn number.
   * @param error - original same-process failure.
   */
  onAgentError(turn: number, error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // AgentLoop balances an in-turn failure with durable turn/end; settlement
    // reads that exact error reason. This slot records interval failures outside it.
    if (inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Whether one tool escalation is already covered by the session's declared
   * roots. Only externally verifiable single-target writes qualify; every other
   * ask must reach the client.
   * @param toolName - tool the approval request names.
   * @param callId - exact call the approval attaches to.
   * @returns true when the recorded call's target lies inside a declared root.
   */
  isPreApprovedEscalation(toolName: string, callId: string): Promise<boolean> {
    const call = this.toolCalls.get(callId)
    if (call === undefined || call.name !== toolName) return Promise.resolve(false)
    const filePath = (call.arguments as { file_path?: unknown } | null | undefined)?.file_path
    return preApprovedEscalation(
      this.ctx,
      this.agent.session,
      this.additionalDirectories,
      toolName,
      typeof filePath === 'string' ? filePath : undefined,
    )
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.commandAbort?.abort(new Error(detail))
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as ContinuableDrain | undefined
      try {
        await subagents?.drainContinuableDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp-plus: continuable subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('continuable subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      this.pendingSelections.clear()
      this.toolCalls.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
    })()
    return this.closing
  }

  /** Run one registered command and settle the ACP prompt after its updates drain. */
  private async executeCommand(line: string, requestSignal?: AbortSignal): Promise<PromptResponse> {
    const commands = this.ctx.get('commands')
    if (commands === undefined) throw internalError('the command registry is not available')
    const controller = new AbortController()
    this.commandAbort = controller
    const signal = requestSignal === undefined
      ? controller.signal
      : AbortSignal.any([requestSignal, controller.signal])
    try {
      const execution = await commands.execute(this.agent, line, [], signal)
      if (execution === undefined) throw invalidParams(`unknown command: ${line}`)
      await this.drainUpdates()
      return { stopReason: 'end_turn' }
    } catch (error: unknown) {
      // A cancelled command is session cancellation, not a handler failure.
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw error
    } finally {
      if (this.commandAbort === controller) this.commandAbort = undefined
    }
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.cancelRequested = true
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (inflight.messageQueued) this.agent.cancel({ kind: 'user' })
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await this.agent.whenIdle()
        await this.outputTail
      }
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
  }

  /** Serialize one notification without letting failure wedge the queue. */
  private enqueue(delivery: () => Promise<void>): void {
    const previous = this.outputTail
    this.outputTail = previous
      .then(delivery)
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp-plus: session update failed: ${errorChain(error)}`)
      })
  }
}
