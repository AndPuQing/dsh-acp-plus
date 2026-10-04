/**
 * Rich prompt/content admission and projection (PLAN.md M0–M1).
 *
 * Behavior ported from `packages/acp/acp/tests/content.spec.ts`: every wire
 * block is validated before any durable image write, capability advertisement
 * is conservative, and committed images are re-read before delivery.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  AcpPlusContentError,
  admitAcpPrompt,
  assistantBlockToAcp,
  supportsAcpImagePrompts,
} from '../src/content.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

interface AdmissionFixture {
  ctx: Context
  route: ModelSelection | undefined
  saveImages: (inputs: readonly SaveImageAttachment[]) => Promise<readonly ImageAttachmentRef[]>
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
  saved: SaveImageAttachment[]
  calls: { saveImages: number; resolveModelInfo: Array<[string, string]> }
}

function admissionFixture(options: {
  attachments?: boolean
  llm?: boolean
  provider?: string | undefined
  model?: string | undefined
  modelInfo?: { inputModalities?: readonly string[] }
  resolveModelInfoError?: Error
} = {}): AdmissionFixture {
  const saved: SaveImageAttachment[] = []
  const calls: AdmissionFixture['calls'] = { saveImages: 0, resolveModelInfo: [] }
  const paths: AdmissionFixture = {
    ctx: undefined as unknown as Context,
    route: undefined,
    saved,
    calls,
    saveImages: async (inputs) => {
      calls.saveImages += 1
      saved.push(...inputs)
      return inputs.map((input, index) => ({
        ...REF,
        attachmentId: AttachmentId(`sha256:${String(index + 1).padStart(64, '0')}`),
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
      }))
    },
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo.push([provider, model])
      if (options.resolveModelInfoError !== undefined) throw options.resolveModelInfoError
      return { provider, id: model, name: model, inputModalities: options.modelInfo?.inputModalities ?? [] }
    },
  }
  const attachments = options.attachments === false ? undefined : { saveImages: paths.saveImages }
  const llm = options.llm === false ? undefined : { resolveModelInfo: paths.resolveModelInfo }
  paths.ctx = {
    get(name: string) {
      if (name === 'attachments') return attachments
      if (name === 'llm') return llm
      return undefined
    },
  } as unknown as Context
  const provider = 'provider' in options ? options.provider : 'mock'
  const model = 'model' in options ? options.model : 'vision'
  paths.route = provider === undefined || model === undefined ? undefined : { provider, model }
  return paths
}

/** Minimal Context whose only service is the named attachment behavior. */
function serviceCtx(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

test('advertises image input only when every deployment prerequisite is explicit', async () => {
  const store = { imageLimits: { mediaTypes: ['image/png'] } }
  const noMediaStore = { imageLimits: { mediaTypes: [] } }
  const imageLlm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  const textLlm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  const unknownLlm = { resolveModelInfo: async () => ({}) }
  const brokenLlm = { resolveModelInfo: async () => { throw new Error('catalog down') } }
  const noAttachment = serviceCtx({ llm: imageLlm })
  const noLlm = serviceCtx({ attachments: store })

  assert.equal(await supportsAcpImagePrompts(noAttachment, 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(noLlm, 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: imageLlm }), undefined, 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: imageLlm }), 'p', undefined), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: noMediaStore, llm: imageLlm }), 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: brokenLlm }), 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: unknownLlm }), 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: textLlm }), 'p', 'm'), false)
  assert.equal(await supportsAcpImagePrompts(serviceCtx({ attachments: store, llm: imageLlm }), 'p', 'm'), true)
})

test('validates every rich wire block before any image write', async () => {
  const fixture = admissionFixture()
  const signal = new AbortController().signal

  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'image', data: 'AQ==', mimeType: 'image/tiff' }] as never, true, signal),
    /mimeType/,
  )
  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'image', data: 'not base64', mimeType: 'image/png' }], true, signal),
    /canonical base64/,
  )
  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'image', data: 'AB==', mimeType: 'image/png' }], true, signal),
    /canonical base64/,
  )
  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'audio', data: 'AQ==', mimeType: 'audio/wav' }], true, signal),
    /audio prompt/,
  )
  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'resource', resource: { uri: 'file:///tmp/a', text: 'a' } }], true, signal),
    /embedded resource/,
  )
  assert.equal(fixture.calls.saveImages, 0)
})

test('requires the advertised capability, store, and exact image-capable route', async () => {
  const prompt = [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] as const
  const signal = new AbortController().signal

  const capable = admissionFixture()
  await assert.rejects(admitAcpPrompt(capable.ctx, capable.route, prompt, false, signal), /not advertised/)

  const noStore = admissionFixture({ attachments: false })
  await assert.rejects(admitAcpPrompt(noStore.ctx, noStore.route, prompt, true, signal), /no attachment store/)

  const noProvider = admissionFixture({ provider: undefined })
  await assert.rejects(admitAcpPrompt(noProvider.ctx, noProvider.route, prompt, true, signal), /route could not be resolved/)
  const noModel = admissionFixture({ model: undefined })
  await assert.rejects(admitAcpPrompt(noModel.ctx, noModel.route, prompt, true, signal), /route could not be resolved/)
  const noLlm = admissionFixture({ llm: false })
  await assert.rejects(admitAcpPrompt(noLlm.ctx, noLlm.route, prompt, true, signal), /route could not be resolved/)

  const broken = admissionFixture({ resolveModelInfoError: new Error('catalog down') })
  await assert.rejects(admitAcpPrompt(broken.ctx, broken.route, prompt, true, signal), (error: AcpPlusContentError) => {
    assert.equal(error.kind, 'internal')
    assert.match(error.message, /route could not be verified/)
    return true
  })
  const unknown = admissionFixture({ modelInfo: {} })
  await assert.rejects(admitAcpPrompt(unknown.ctx, unknown.route, prompt, true, signal), /does not declare image input/)
  const textOnly = admissionFixture({ modelInfo: { inputModalities: ['text'] } })
  await assert.rejects(admitAcpPrompt(textOnly.ctx, textOnly.route, prompt, true, signal), /does not declare image input/)

  const routed = admissionFixture({ provider: 'live', model: 'vision-2', modelInfo: { inputModalities: ['image'] } })
  assert.equal((await admitAcpPrompt(routed.ctx, routed.route, prompt, true, signal)).length, 1)
  assert.deepEqual(routed.calls.resolveModelInfo, [['live', 'vision-2']])
})

test('classifies image-policy failures separately from durable write failures', async () => {
  const prompt = [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] as const
  const signal = new AbortController().signal

  const cases: ReadonlyArray<readonly [Error, 'invalid' | 'internal', RegExp]> = [
    [new AttachmentError('too many', 'TOO_MANY_IMAGES'), 'invalid', /too many/],
    [new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'), 'internal', /unable to persist/],
    [new AttachmentError('corrupt object', 'ATTACHMENT_CORRUPT'), 'internal', /unable to persist/],
  ]
  for (const [failure, kind, message] of cases) {
    const fixture = admissionFixture({ modelInfo: { inputModalities: ['image'] } })
    fixture.saveImages = async () => { throw failure }
    const ctx = serviceCtx({
      attachments: { saveImages: fixture.saveImages },
      llm: { resolveModelInfo: fixture.resolveModelInfo },
    })
    await assert.rejects(admitAcpPrompt(ctx, fixture.route, prompt, true, signal), (error: AcpPlusContentError) => {
      assert.equal(error.kind, kind)
      assert.match(error.message, message)
      return true
    })
  }

  const unknown = admissionFixture({ modelInfo: { inputModalities: ['image'] } })
  unknown.saveImages = async () => { throw new Error('unknown store failure') }
  const unknownCtx = serviceCtx({
    attachments: { saveImages: unknown.saveImages },
    llm: { resolveModelInfo: unknown.resolveModelInfo },
  })
  await assert.rejects(
    admitAcpPrompt(unknownCtx, unknown.route, prompt, true, signal),
    (error: unknown) => error instanceof AcpPlusContentError,
  )
})

test('honors cancellation on both sides of the durable image write', async () => {
  const prompt = [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] as const

  const before = admissionFixture({ modelInfo: { inputModalities: ['image'] } })
  const beforeController = new AbortController()
  beforeController.abort(new Error('cancel before write'))
  await assert.rejects(admitAcpPrompt(before.ctx, before.route, prompt, true, beforeController.signal), /cancel before write/)
  assert.equal(before.calls.saveImages, 0)

  const after = admissionFixture({ modelInfo: { inputModalities: ['image'] } })
  const afterController = new AbortController()
  const saving = after.saveImages
  let writes = 0
  const afterCtx = serviceCtx({
    attachments: {
      saveImages: async (inputs: readonly SaveImageAttachment[]) => {
        writes += 1
        const refs = await saving(inputs)
        afterController.abort(new Error('cancel after write'))
        return refs
      },
    },
    llm: { resolveModelInfo: after.resolveModelInfo },
  })
  await assert.rejects(admitAcpPrompt(afterCtx, after.route, prompt, true, afterController.signal), /cancel after write/)
  assert.equal(writes, 1)
})

test('reconstructs image-only and baseline prompts without empty text blocks', async () => {
  const fixture = admissionFixture({ modelInfo: { inputModalities: ['image'] } })
  const signal = new AbortController().signal
  const imageOnly = await admitAcpPrompt(fixture.ctx, fixture.route, [
    { type: 'image', data: 'AQ==', mimeType: 'image/png' },
  ], true, signal)
  assert.equal(imageOnly.length, 1)
  assert.equal(imageOnly[0]?.type, 'image')

  const baseline = await admitAcpPrompt(fixture.ctx, fixture.route, [
    { type: 'text', text: 'before' },
    { type: 'resource_link', name: 'Guide', uri: 'https://example.test/guide' },
    { type: 'text', text: 'after' },
  ], true, signal)
  assert.deepEqual(baseline, [{
    type: 'text',
    text: 'before\n[resource_link name="Guide" uri="https://example.test/guide"]\nafter',
  }])

  await assert.rejects(
    admitAcpPrompt(fixture.ctx, fixture.route, [{ type: 'text', text: ' \n ' }], true, signal),
    /empty prompt/,
  )
})

test('projects only non-empty text and verified durable images to ACP', async () => {
  const fixture = admissionFixture()
  assert.equal(await assistantBlockToAcp(fixture.ctx, { type: 'text', text: '' }), undefined)
  assert.deepEqual(await assistantBlockToAcp(fixture.ctx, { type: 'text', text: 'hello' }), {
    type: 'text', text: 'hello',
  })
  assert.equal(await assistantBlockToAcp(fixture.ctx, { type: 'reasoning', text: 'private' }), undefined)

  await assert.rejects(
    assistantBlockToAcp(serviceCtx({}), { type: 'image', attachment: REF }),
    /no attachment store/,
  )
  const missingCtx = serviceCtx({
    attachments: { readImage: async () => { throw new AttachmentError('gone', 'ATTACHMENT_NOT_FOUND') } },
  })
  await assert.rejects(assistantBlockToAcp(missingCtx, { type: 'image', attachment: REF }), /unavailable or corrupt/)
  const storedCtx = serviceCtx({
    attachments: { readImage: async () => ({ ref: REF, data: Uint8Array.of(1) }) },
  })
  assert.deepEqual(await assistantBlockToAcp(storedCtx, { type: 'image', attachment: REF }), {
    type: 'image', data: 'AQ==', mimeType: 'image/png',
  })
})
