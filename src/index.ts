/**
 * Extended Agent Client Protocol server over JSON-RPC stdio.
 *
 * A protocol driver: it consumes core services (`agents`, `sessions`,
 * `sessionPersistence`, `llm`) and owns only the wire. It is not a core seam —
 * there is no `ctx.acp` to implement — so it mounts like any other Cordis
 * plugin through a profile patch row.
 *
 * Reference implementation for every mapping below:
 * `packages/acp/acp/src/index.ts` in the harness checkout.
 *
 * @module dsh-acp-plus
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges the deployment default-model service.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type import: declaration-merges `ctx.workspaceRegistry` and names its service.
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
// Side-effect type import: declaration-merges `user-questions/request`.
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionModeState,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { Config, resolveSpec, type AcpPlusConfig, type AcpPlusSpec } from './config.ts'
import { supportsAcpImagePrompts } from './content.ts'
import {
  AcpPlusAdditionalDirectoriesError,
  authorizeAdditionalDirectories,
} from './features/additional-directories.ts'
import { answerWithElicitation, type AcpElicitationHost } from './features/elicitation.ts'
import { forkPrefix } from './features/fork.ts'
import { AcpPlusSessionModeError } from './features/modes.ts'
import { sessionPlan, subscribeTodoPlans } from './features/plan.ts'
import { readSessionEvents, replaySession } from './features/session-load.ts'
import {
  parseSteeringRequest,
  STEERING_METHOD,
  steeringInitializeMeta,
  steeringText,
  type SteeringRequest,
  type SteeringResponse,
} from './features/steering.ts'
import { AcpPlusMcpConfigError } from './mcp.ts'
import { AcpPlusModelConfigError } from './model-control.ts'
import { AcpPlusSession } from './sessions.ts'
import { usageUpdate } from './updates.ts'

export { Config }
export type { AcpPlusConfig }

/** Package version reported to ACP clients; `package.json` is the source of truth. */
const AGENT_VERSION = (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? '0.0.0'

/** Stable Cordis plugin name. */
export const name = 'acp-plus'

/** Core services the bridge consumes; missing ones park the row before it claims stdio. */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Invalid-parameter detail preserved on the wire. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Failed-turn detail preserved on the wire. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Mount the extended ACP bridge.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: AcpPlusConfig): void {
  const spec = resolveSpec(config)
  const persistence = ctx.sessionPersistence

  /**
   * Effective initial route for a new or restored session: the deployment's
   * explicit provider/model, or the live `agent-default-model` service — the
   * same default the Web Models page writes — so a profile configures models
   * once and every entry point, this bridge included, follows. Absent when a
   * listener (embedded use) supplies the route instead.
   */
  const initialSelection = (): ModelSelection | undefined => {
    if (spec.selection !== undefined) return { ...spec.selection }
    return ctx.get('agentDefaultModel')?.currentSelection()
  }
  const logger = ctx.logger
  const sessions = new Map<SessionId, AcpPlusSession>()
  const activating = new Set<SessionId>()
  let closed = false
  let imagePromptEnabled = false
  let clientElicitationSupport = false

  /** Validate workspace params and authorize any requested additional roots. */
  const authorizeWorkspace = async (
    params: { cwd: string; additionalDirectories?: string[] | null },
  ): Promise<readonly string[]> => {
    validateWorkspaceParams(params, spec.features.additionalDirectories)
    if (!spec.features.additionalDirectories) return []
    try {
      return await authorizeAdditionalDirectories(params.cwd, params.additionalDirectories ?? [])
    } catch (error: unknown) {
      if (error instanceof AcpPlusAdditionalDirectoriesError) throw invalidParams(error.message)
      throw error
    }
  }

  /**
   * The workspace registry, when the deployment mounts one. It is reached
   * through `inject` rather than `ctx.get`: the `workspace` row sits in this
   * bundle's layer, so a sibling lookup from this fiber misses it while the
   * injection still binds. Deployments without the row stay `undefined`.
   */
  let workspaceRegistry: WorkspaceRegistry | undefined
  const pendingWorkspaceAttachments: Array<{ session: Session; cwd: string }> = []

  /** Attach one session to the workspace for its cwd; never fails the request. */
  const attachToWorkspace = async (session: Session, cwd: string): Promise<void> => {
    const registry = workspaceRegistry
    if (registry === undefined) return
    try {
      const workspace = await registry.create(cwd)
      await workspace.attachSession(session.id)
    } catch (error: unknown) {
      logger.warn(`workspace attach failed for session ${session.id}: ${String(error)}`)
    }
  }

  ctx.inject(['workspaceRegistry'], (injected) => {
    workspaceRegistry = injected.workspaceRegistry
    for (const queued of pendingWorkspaceAttachments.splice(0)) {
      void attachToWorkspace(queued.session, queued.cwd)
    }
    return () => {
      workspaceRegistry = undefined
    }
  })

  /**
   * Group one materialized session under the Workspace for its cwd, so
   * workspace-grouped surfaces (the Web sidebar) list ACP sessions under their
   * project instead of the "ungrouped" bucket. The `workspace` row finishes
   * its storage bootstrap after the ACP server starts serving, so a session
   * that arrives first is queued for the injection above instead of blocking
   * the request. Grouping is cosmetic: a deployment without the registry, or a
   * registration that rejects, is logged and never fails the ACP request.
   */
  const attachWorkspace = async (session: Session, cwd: string): Promise<void> => {
    if (workspaceRegistry === undefined) {
      pendingWorkspaceAttachments.push({ session, cwd })
      return
    }
    await attachToWorkspace(session, cwd)
  }

  const ownedRecord = (agent: Parameters<AcpPlusSession['owns']>[0]): AcpPlusSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpPlusSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Ordered `session/update` delivery; transport failure is logged, never fatal to Agent work. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification)
    } catch (error: unknown) {
      logger.warn(`acp-plus: session/update failed: ${String(error)}`)
    }
  }

  /** Cancellation options for one outgoing client request. */
  const cancellation = (signal: AbortSignal | undefined): { cancellationSignal: AbortSignal } | undefined =>
    signal === undefined ? undefined : { cancellationSignal: signal }

  /** Elicitation operations backed by this connection. */
  const elicitationHost: AcpElicitationHost = {
    create: (params, signal) => conn.request(methods.client.elicitation.create, params, cancellation(signal)),
  }

  /** Include `modes` only when the deployment offers them, preserving native responses. */
  const modesOption = (record: AcpPlusSession): { modes?: SessionModeState } => {
    const modes = record.modeState()
    return modes === undefined ? {} : { modes }
  }

  /** Publish the command list once the lifecycle response has been written. */
  const publishCommandsAfterResponse = (record: AcpPlusSession): void => {
    const timer = setTimeout(() => { record.publishCommands() }, 0)
    timer.unref?.()
  }

  // Client-declared interaction surfaces. Commands and modes are additive and
  // client-visible only; elicitation requires the client's form capability.
  ctx.on('user-questions/request', (request, next) => {
    if (!clientElicitationSupport || request.agent === undefined) return next()
    const record = ownedRecord(request.agent)
    if (record === undefined) return next()
    return answerWithElicitation(elicitationHost, record.agent.session.id, request)
  })

  ctx.on('commands/change', () => {
    for (const record of sessions.values()) record.publishCommands()
  })

  // The optional `todos` projection drives the ACP plan: every change is a
  // wholesale update, delivered only to the record that owns the session.
  subscribeTodoPlans(ctx, (session, update) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.publishUpdate(update)
  })

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Machine permission channel. One-shot choices only: never infer a durable
  // grant from a client response. Declared additional roots pre-approve the
  // verified single-target writes inside them; every other ask is forwarded.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(async () => {
      // Only sandbox escalations are eligible for the declared-root grant; an
      // unrelated pre-execute ask keeps its normal client round trip. The
      // prefix is the core's escalation reason format, so an upstream change
      // degrades to asking the client, never to over-approving.
      if (
        request.reason?.startsWith('escalate sandbox to ') === true
        && await record.isPreApprovedEscalation(request.toolName, callId)
      ) return 'allowed-once' as const
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      const { outcome } = await conn.request(methods.client.session.requestPermission, params)
      if (outcome.outcome === 'cancelled') return 'cancelled' as const
      return outcome.optionId === 'allow-once' ? 'allowed-once' as const : 'rejected' as const
    })
  })

  const implementation = {
    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      const initial = initialSelection()
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, initial?.provider, initial?.model)
      clientElicitationSupport = params.clientCapabilities?.elicitation?.form != null
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-acp-plus', version: AGENT_VERSION },
        agentCapabilities: {
          // `load` is this bridge's increment over native `resume`; it is only
          // advertised when the deployment opted in and the handler serves it.
          ...spec.features.sessionLoad ? { loadSession: true } : {},
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: {
            close: {},
            list: {},
            resume: {},
            // Fork is this bridge's increment over native; advertise it only
            // when the deployment opted in and the handler serves it.
            ...spec.features.sessionFork ? { fork: {} } : {},
            ...spec.features.additionalDirectories ? { additionalDirectories: {} } : {},
          },
        },
        authMethods: [],
        // Advertise the steering extension: clients that speak it (zeron and
        // the org ACP adapters) inject mid-turn text through
        // `_session/steering` instead of cancel-and-reprompt.
        _meta: steeringInitializeMeta(),
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve()
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      assertOpen()
      const additionalDirectories = await authorizeWorkspace(params)
      const sessionId = brandString<SessionId>(randomUUID())
      let record: AcpPlusSession
      try {
        record = await AcpPlusSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          additionalDirectories,
          agentOptions: agentOptions(spec, initialSelection()),
          signal,
          notify,
        })
      } catch (error: unknown) {
        if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
          throw invalidParams(error.message)
        }
        throw error
      }
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        assertOpen()
        // The attached log writer's flush materializes an empty session durably.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        await attachWorkspace(record.agent.session, params.cwd)
        publishCommandsAfterResponse(record)
        return { sessionId, configOptions, ...modesOption(record) }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
          || activating.has(header.id)
          || ctx.sessions.get(header.id) !== undefined
          || header.origin === 'subagent'
          || header.cwd === undefined
          || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, spec.sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      assertOpen()
      const additionalDirectories = await authorizeWorkspace(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<ResumeSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || persisted.origin === 'subagent') {
          throw invalidParams(`session is not resumable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpPlusSession
        try {
          record = await AcpPlusSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            additionalDirectories,
            agentOptions: agentOptions(spec, initialSelection()),
            signal,
            notify,
          })
        } catch (error: unknown) {
          if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
            throw invalidParams(error.message)
          }
          throw error
        }
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/resume cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        if (closed) {
          await record.close('connection closed during session/resume')
          throw internalError('connection closed during session/resume')
        }
        await attachWorkspace(record.agent.session, params.cwd)
        sessions.set(sessionId, record)
        try {
          publishCommandsAfterResponse(record)
          return { configOptions: await record.configOptions(signal), ...modesOption(record) }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/resume option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async loadSession(params: LoadSessionRequest, signal: AbortSignal): Promise<LoadSessionResponse> {
      assertOpen()
      if (!spec.features.sessionLoad) throw invalidParams('session/load is not enabled by this deployment')
      const additionalDirectories = await authorizeWorkspace(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<LoadSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || persisted.origin === 'subagent') {
          throw invalidParams(`session is not loadable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        // Pure read before the live Agent exists: nothing live can interleave
        // with the replayed transcript, and replay itself starts no work. A
        // connection that dies mid-replay stops at the next update instead of
        // walking the rest of a long log.
        await replaySession(ctx, sessionId, (notification) => {
          if (closed) return Promise.reject(internalError('connection closed during session/load'))
          return notify(notification)
        }, signal)
        let record: AcpPlusSession
        try {
          record = await AcpPlusSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            additionalDirectories,
            agentOptions: agentOptions(spec, initialSelection()),
            signal,
            notify,
          })
        } catch (error: unknown) {
          if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
            throw invalidParams(error.message)
          }
          throw error
        }
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/load cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        if (closed) {
          await record.close('connection closed during session/load')
          throw internalError('connection closed during session/load')
        }
        await attachWorkspace(record.agent.session, params.cwd)
        // Publish nothing for the id before the whole history plus the final
        // state readings are delivered; a concurrent prompt then waits in the
        // request channel instead of interleaving with replay. Replay starts no
        // projection drive, so the current plan is read from the registry.
        const plan = sessionPlan(ctx, record.agent.session)
        if (plan !== undefined) await notify({ sessionId, update: plan })
        const pressure = usageUpdate(ctx, record.agent.session)
        if (pressure !== undefined) await notify({ sessionId, update: pressure })
        sessions.set(sessionId, record)
        try {
          publishCommandsAfterResponse(record)
          return { configOptions: await record.configOptions(signal), ...modesOption(record) }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/load option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async forkSession(params: ForkSessionRequest, signal: AbortSignal): Promise<ForkSessionResponse> {
      assertOpen()
      if (!spec.features.sessionFork) throw invalidParams('session/fork is not enabled by this deployment')
      const additionalDirectories = await authorizeWorkspace(params)
      const sourceId = brandString<SessionId>(params.sessionId)
      // A live source can still hold buffered events; flush before reading so
      // the child inherits everything the source has durably committed.
      const liveSource = ctx.sessions.get(sourceId)
      if (liveSource !== undefined) {
        try {
          await ctx.sessions.flush(liveSource)
        } catch (error: unknown) {
          throw internalError(`failed to flush the fork source: ${errorChain(error)}`)
        }
      }
      const persisted = (await persistence.stat(sourceId, { signal }))?.header
      // Subagent-produced sessions are internal work products of their parent,
      // not conversations; plain historical forks (which may carry
      // `parentSession` lineage) remain forkable.
      if (persisted === undefined || persisted.origin === 'subagent') {
        throw invalidParams(`session is not forkable: ${sourceId}`)
      }
      if (!await sameDirectory(persisted.cwd, params.cwd)) {
        throw invalidParams(`session cwd does not match: ${params.cwd}`)
      }
      const prefix = forkPrefix(await readSessionEvents(ctx, sourceId, signal))
      if (prefix === undefined) {
        throw invalidParams(`session has no completed turn to fork from: ${sourceId}`)
      }
      const sessionId = brandString<SessionId>(randomUUID())
      let record: AcpPlusSession
      try {
        record = await AcpPlusSession.fork(ctx, {
          sessionId,
          seed: prefix.seed,
          inheritedEventCount: prefix.inheritedEventCount,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          additionalDirectories,
          agentOptions: agentOptions(spec, initialSelection()),
          signal,
          notify,
        })
      } catch (error: unknown) {
        if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
          throw invalidParams(error.message)
        }
        throw error
      }
      if (closed) {
        await record.close('connection closed during session/fork')
        throw internalError('connection closed during session/fork')
      }
      sessions.set(sessionId, record)
      try {
        // Materialize the seeded log durably so the child is listable and
        // resumable even if the client never prompts it.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        await attachWorkspace(record.agent.session, params.cwd)
        publishCommandsAfterResponse(record)
        return { sessionId, configOptions: await record.configOptions(signal), ...modesOption(record) }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/fork activation failed')
        throw error
      }
    },

    setSessionMode(params: SetSessionModeRequest): SetSessionModeResponse {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        record.setMode(params.modeId)
      } catch (error: unknown) {
        if (error instanceof AcpPlusSessionModeError) throw invalidParams(error.message)
        throw error
      }
      return {}
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (error instanceof AcpPlusModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    /**
     * Serve the `_session/steering` extension: inject text into the live turn,
     * or hand it back for normal prompt admission when nothing is running.
     */
    steerSession(params: SteeringRequest): SteeringResponse {
      assertOpen()
      if (typeof params.sessionId !== 'string' || params.sessionId === '') {
        throw invalidParams('_session/steering requires a sessionId')
      }
      const record = requireSession(brandString<SessionId>(params.sessionId))
      const text = steeringText(params.prompt)
      if (text === undefined) return { outcome: 'promptRequired', reason: 'noRunningTurn' }
      return record.steer(text)
        ? { outcome: 'injected' }
        : { outcome: 'promptRequired', reason: 'noRunningTurn' }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        await record.close('ACP session closed')
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  const stream: Stream = spec.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const app = createAcpAgentApp({ name: 'dsh-acp-plus' })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.load, ({ params, signal }) => implementation.loadSession(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.fork, ({ params, signal }) => implementation.forkSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setMode, ({ params }) => implementation.setSessionMode(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onRequest(STEERING_METHOD, parseSteeringRequest, ({ params }) => implementation.steerSession(params))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  const connection = app.connect(stream)
  const conn: AgentContext = connection.client

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    // AcpPlusSession.close cancels synchronously before its first await, so every
    // owned prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      for (const record of records) {
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp-plus: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp-plus: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'acp-plus.connection')
}

/**
 * Build per-agent options from the explicit spec, else the live deployment
 * default. The Agent's own selection projection takes precedence over these
 * options once a session records a selection or a request, so a resumed
 * session keeps its logged route.
 */
function agentOptions(spec: AcpPlusSpec, fallback: ModelSelection | undefined): AgentOptions {
  const selection = spec.selection ?? fallback
  if (selection === undefined) return {}
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Reject workspace features outside the enabled contract. */
function validateWorkspaceParams(
  params: { cwd: string; additionalDirectories?: string[] | null },
  additionalDirectories: boolean,
): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    !additionalDirectories
    && params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
  // Enabled requests are authorized by `authorizeAdditionalDirectories`; the
  // setup-time policy probe then rejects anything the sandbox cannot reach.
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
