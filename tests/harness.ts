/**
 * In-memory ACP transport fixture over the real Agent loop and persistence.
 *
 * Keyless: a scripted `LlmAdapter` and a temp-directory JSONL log replace any
 * network call. The fixture drives the official SDK `ClientSideConnection`, so
 * tests exercise the real wire, the real Agent loop, and the real persistence
 * layer. Tests own disposal; `persistenceRoot` may be reused across harnesses
 * to simulate a process restart.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  type Agent as AcpAgent,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SendRequestOptions,
  type SessionNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
} from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, ReasoningEffortId, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as NativeAcp from '@deepseek-ai/dsh-acp'
import type { AcpConfig as NativeAcpConfig } from '@deepseek-ai/dsh-acp'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as AcpPlugin from '../src/index.ts'
import type { AcpPlusConfig } from '../src/index.ts'

/** Scripted adapter for protocol tests. */
export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly imageCapable: boolean,
    private readonly provider = 'mock',
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    if (provider !== this.provider) throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: this.provider, name: this.provider === 'mock' ? 'Mock' : `Mock ${this.provider}` }
  }

  override listModels(provider: string): Promise<LlmResolvedModelInfo[]> {
    return Promise.resolve(provider === this.provider ? [
      {
        provider: this.provider,
        id: 'mock',
        name: 'Mock Reasoner',
        description: 'Mock model with selectable reasoning.',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      } as unknown as LlmResolvedModelInfo,
    ] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable && model === 'mock' ? ['text', 'image'] : ['text'],
      context: { contextWindow: 1_024 },
      ...model === 'mock' ? {
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {},
    } as LlmResolvedModelInfo)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted === true) throw new Error('aborted')
      yield chunk
    }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** In-memory durable store for wire-order and lifecycle tests. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }

  override saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

/** Scripted single tool call ending in a clean tool-calls stop. */
export function toolCallResponse(name: string, id: string, args: unknown): StreamChunk[] {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Captured elicitation traffic and the scripted behavior answering it. */
export interface ElicitationFixture {
  requests: CreateElicitationRequest[]
  behavior: {
    /** Response action the client returns. */
    action: 'accept' | 'decline' | 'cancel'
    /** Accepted form content, keyed by requested property name. */
    content: Record<string, unknown>
    /** Hold `elicitation/create` open until the question is withdrawn. */
    hang: boolean
  }
}

/** Captured `session/update` payload as the client observed it. */
export type CapturedUpdate = SessionNotification['update']

/** Stable-v1 client methods exercised by the bridge tests. */
export interface BridgeClient {
  initialize: NonNullable<AcpAgent['initialize']>
  newSession: NonNullable<AcpAgent['newSession']>
  listSessions: NonNullable<AcpAgent['listSessions']>
  /** Normalized to always resolve a response object; the SDK type also allows void. */
  loadSession: (params: LoadSessionRequest) => Promise<LoadSessionResponse>
  /** Normalized to always resolve a response object; the SDK type also allows void. */
  resumeSession: (params: ResumeSessionRequest) => Promise<ResumeSessionResponse>
  closeSession: NonNullable<AcpAgent['closeSession']>
  setSessionConfigOption: NonNullable<AcpAgent['setSessionConfigOption']>
  setSessionMode: (params: SetSessionModeRequest) => Promise<SetSessionModeResponse>
  prompt: (params: PromptRequest, options?: SendRequestOptions) => Promise<PromptResponse>
  /** Custom `_session/steering` extension request. */
  steer: (params: { sessionId: string; prompt: unknown; _meta?: unknown }) => Promise<unknown>
  cancel: NonNullable<AcpAgent['cancel']>
}

/** One connected bridge plus the client, adapter, and captured traffic. */
export interface BridgeHarness {
  ctx: Context
  client: BridgeClient
  adapter: MockAdapter
  updates: CapturedUpdate[]
  permissionRequests: RequestPermissionRequest[]
  elicitation: ElicitationFixture
  persistenceRoot: string
  dispose: () => Promise<void>
}

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: Partial<AcpPlusConfig>
  /** Mount the deployment default-model service; also drops the implicit mock provider/model config. */
  defaultModel?: { provider: string; model: string }
  imageCapable?: boolean
  attachments?: boolean
  persistenceRoot?: string
  /** Mount a confining sandbox policy with this default mode. */
  sandboxMode?: SandboxMode
  /** Mount the real filesystem backend, approval service, and `write`/`edit` tools. */
  filesystemTools?: boolean
  /** Mount the command registry for slash-command tests. */
  commands?: boolean
  /** Mount the plan-mode controller for session-mode tests. */
  planMode?: boolean
  /** Mount the user-question service and its model-facing tool. */
  userQuestions?: boolean
  /** Scripted elicitation behavior. */
  elicitation?: Partial<ElicitationFixture['behavior']>
  /** Which bridge to mount; defaults to this repository's extended bridge. */
  bridge?: 'ext' | 'native'
} = {}): Promise<BridgeHarness> {
  if (options.filesystemTools === true && options.sandboxMode === undefined) {
    throw new Error('makeBridgeHarness: filesystemTools requires sandboxMode')
  }
  const adapter = new MockAdapter(options.script ?? [], options.imageCapable === true)
  const ctx = new Context()
  const ownsPersistenceRoot = options.persistenceRoot === undefined
  const persistenceRoot = options.persistenceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-acp-plus-test-'))
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
  if (options.defaultModel !== undefined) {
    await ctx.plugin(AgentDefaultModel, {
      provider: options.defaultModel.provider,
      model: options.defaultModel.model,
    })
  }
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(TokenMeter)
  if (options.sandboxMode !== undefined) {
    await ctx.plugin(SandboxPolicyService, { mode: options.sandboxMode, workspaceRoot: process.cwd() })
  }
  if (options.filesystemTools === true) {
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SandboxedFileSystem, {})
    await ctx.plugin(ToolFs as unknown as Parameters<Context['plugin']>[0], {})
  }
  if (options.commands === true) await ctx.plugin(CommandRuntime)
  if (options.planMode === true) await ctx.plugin(PlanModeController, { section: 'Plan mode is active.' })
  if (options.userQuestions === true) {
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ToolAskUser as unknown as Parameters<Context['plugin']>[0])
  }
  if (options.attachments !== false) await ctx.plugin(MemoryAttachmentStore)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const elicitation: ElicitationFixture = {
    requests: [],
    behavior: {
      action: 'accept',
      content: {},
      hang: false,
      ...options.elicitation,
    },
  }
  const harness: BridgeHarness = {
    ctx,
    adapter,
    updates,
    permissionRequests,
    elicitation,
    persistenceRoot,
    client: undefined as unknown as BridgeClient,
    dispose: async () => {
      await ctx.fiber.dispose()
      if (ownsPersistenceRoot) await rm(persistenceRoot, { recursive: true, force: true })
    },
  }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-plus-test-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params)
      return Promise.resolve<RequestPermissionResponse>({ outcome: { outcome: 'cancelled' } })
    })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      elicitation.requests.push(params)
      if (elicitation.behavior.hang) return new Promise<CreateElicitationResponse>(() => {})
      if (elicitation.behavior.action === 'accept') {
        return Promise.resolve<CreateElicitationResponse>({
          action: 'accept',
          content: elicitation.behavior.content as CreateElicitationResponse extends { content?: infer C } ? C : never,
        })
      }
      return Promise.resolve<CreateElicitationResponse>({ action: elicitation.behavior.action })
    })
  const config: AcpPlusConfig = {
    stream: agentStream,
    // An explicit deployment route is the default; mounting the default-model
    // service instead exercises the bridge's fallback.
    ...options.defaultModel === undefined ? { provider: 'mock', model: 'mock' } : {},
    ...options.config,
  }
  if (options.bridge === 'native') {
    const nativeConfig: NativeAcpConfig = {
      stream: agentStream,
      provider: 'mock',
      model: 'mock',
      ...config.sessionListPageSize === undefined ? {} : { sessionListPageSize: config.sessionListPageSize },
    }
    await ctx.plugin({
      name: 'native-acp-test',
      inject: [...NativeAcp.inject],
      apply: (inner: Context) => { NativeAcp.apply(inner, nativeConfig) },
    })
  } else {
    await ctx.plugin({
      name: 'acp-plus-test',
      inject: [...AcpPlugin.inject],
      apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
    })
  }

  const clientConnection = clientApp.connect(clientStream)
  const client = clientConnection.agent
  harness.client = {
    initialize: params => client.request(methods.agent.initialize, params),
    newSession: params => client.request(methods.agent.session.new, params),
    listSessions: params => client.request(methods.agent.session.list, params),
    loadSession: async params => (await client.request(methods.agent.session.load, params)) ?? {},
    resumeSession: async params => (await client.request(methods.agent.session.resume, params)) ?? {},
    closeSession: params => client.request(methods.agent.session.close, params),
    setSessionConfigOption: params => client.request(methods.agent.session.setConfigOption, params),
    setSessionMode: async params => (await client.request(methods.agent.session.setMode, params)) ?? {},
    prompt: (params, requestOptions) => client.request(methods.agent.session.prompt, params, requestOptions),
    steer: params => client.request('_session/steering' as never, params as never),
    cancel: params => client.notify(methods.agent.session.cancel, params),
  }
  return harness
}

/** Poll until a predicate holds; the loop is the source of truth, not a timer. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
