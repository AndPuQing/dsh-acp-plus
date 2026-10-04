/**
 * Plugin configuration and its explicit resolution step.
 *
 * Defaulting lives here, not inside the bridge body: `apply()` receives a
 * fully resolved spec, so a deployment choice is always visible in cordis.yml
 * and projected by `--dump-config-schema`.
 *
 * @module dsh-acp-plus/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Stream } from '@agentclientprotocol/sdk'

/** Deployment-owned configuration of the extended ACP bridge. */
export interface AcpPlusConfig {
  /** Provider route for agents created by this bridge. */
  provider?: string
  /** Model for agents created by this bridge. */
  model?: string
  /** Maximum summaries returned by one `session/list` page. */
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
  /** Advertise and serve `session/load` (M2; transcript replay on reopen). */
  enableSessionLoad?: boolean
  /**
   * Accept `additionalDirectories` on session lifecycle requests (M3).
   * Verified single-target writes under a declared root are pre-approved
   * through the existing sandbox escalation; every other ask still reaches
   * the client.
   */
  enableAdditionalDirectories?: boolean
}

/** Schemastery schema validating the fields above. */
export const Config: Schema<AcpPlusConfig> = Schema.object({
  provider: Schema.string().description('Provider route for agents created by this bridge, e.g. deepseek-official.'),
  model: Schema.string().description('Exact model id for agents created by this bridge, e.g. deepseek-v4-flash.'),
  sessionListPageSize: Schema.natural().min(1).default(100)
    .description('Maximum sessions returned by one session/list page.'),
  enableSessionLoad: Schema.boolean().default(false)
    .description('Advertise and serve session/load: replay the persisted transcript after reopening.'),
  enableAdditionalDirectories: Schema.boolean().default(false)
    .description('Accept additionalDirectories; verified single-target writes under a declared root are pre-approved.'),
})

/** Resolved configuration consumed by the bridge. */
export interface AcpPlusSpec {
  /** Deployment provider route, or undefined when a listener supplies it. */
  provider: string | undefined
  /** Deployment model, or undefined when a listener supplies it. */
  model: string | undefined
  /** Initial provider/model selection, or undefined when a listener supplies it. */
  selection: ModelSelection | undefined
  /** Validated page size for `session/list`. */
  sessionListPageSize: number
  /** Test transport, or undefined for stdio. */
  stream: Stream | undefined
  /** Feature gates, resolved once at mount. */
  features: {
    sessionLoad: boolean
    additionalDirectories: boolean
  }
}

/**
 * Resolve deployment request fields into the spec the bridge runs on.
 * @param config - validated plugin configuration.
 * @returns the resolved spec, with defaults applied once.
 */
export function resolveSpec(config: AcpPlusConfig): AcpPlusSpec {
  const selection = config.provider === undefined || config.model === undefined
    ? undefined
    : { provider: config.provider, model: config.model }
  return {
    provider: config.provider,
    model: config.model,
    selection,
    sessionListPageSize: config.sessionListPageSize ?? 100,
    stream: config.stream,
    features: {
      sessionLoad: config.enableSessionLoad ?? false,
      additionalDirectories: config.enableAdditionalDirectories ?? false,
    },
  }
}
