/**
 * `_session/steering` extension: mid-turn text injection (PLAN.md M7 / D11).
 *
 * The extension is defined by the agentclientprotocol org adapters and spoken
 * by zeron's ACP driver: when `initialize._meta.steering.supported` is true,
 * the client sends `_session/steering` with the same prompt shape as
 * `session/prompt` plus `_meta.steering.idleBehavior: "promptRequired"`.
 * A live turn consumes the text at its next step boundary (`agent.steer`);
 * an idle session answers `{ outcome: "promptRequired", reason:
 * "noRunningTurn" }` so the client redelivers the text as a normal prompt
 * instead of starting an untracked turn.
 *
 * @module dsh-acp-plus/features/steering
 */

/** Custom ACP method name of the steering extension. */
export const STEERING_METHOD = '_session/steering'

/** Raw `_session/steering` params as sent by the extension's clients. */
export interface SteeringRequest {
  sessionId: string
  prompt?: unknown
  _meta?: { steering?: { idleBehavior?: string } }
}

/** Wire response both the org adapters and zeron's client understand. */
export type SteeringResponse =
  | { outcome: 'injected' }
  | { outcome: 'promptRequired', reason: 'noRunningTurn' }

/** `initialize` metadata advertising the extension. */
export function steeringInitializeMeta(): { steering: { supported: true } } {
  return { steering: { supported: true } }
}

/**
 * Parse raw request params without trusting the client.
 * @param params - raw JSON-RPC params.
 * @returns the params object; malformed input throws.
 */
export function parseSteeringRequest(params: unknown): SteeringRequest {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('_session/steering params must be an object')
  }
  return params as SteeringRequest
}

/**
 * Extract text from an extension prompt array. Text-only by design: any other
 * block shape returns undefined, and the handler hands the whole steer back to
 * normal `session/prompt` admission, which owns rich-content validation.
 * @param prompt - raw `prompt` value from the request.
 * @returns the concatenated non-blank text, or undefined when unsupported.
 */
export function steeringText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt) || prompt.length === 0) return undefined
  const texts: string[] = []
  for (const block of prompt) {
    if (typeof block !== 'object' || block === null) return undefined
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') return undefined
    texts.push(text)
  }
  const text = texts.join('')
  return text.trim() === '' ? undefined : text
}
