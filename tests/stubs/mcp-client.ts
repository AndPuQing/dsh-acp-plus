/**
 * Test-only stand-in for `@deepseek-ai/dsh-mcp-client`.
 *
 * The bridge test mounts no MCP servers, so the real transport stack (which
 * needs optional native and network packages) is out of scope for M0. The real
 * module is still the type/parity reference and is exercised by the M1 parity
 * suite when it lands.
 */

/** Pass-through config parser matching the real module's call shape. */
export function Config(value: unknown): unknown {
  return value
}

/** Stable plugin name so `ctx.plugin` would accept this namespace if called. */
export const name = 'dsh-mcp-client-stub'

/** No services required by the stub. */
export const inject: string[] = []

/** No-op mount; `mcpServers: []` never reaches this in the bridge test. */
export function apply(): void {}
