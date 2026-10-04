/**
 * Command-line and stdin-lifetime provider for the `acp-plus` profile.
 *
 * Mirrors `packages/bundle/acp-app/src/index.ts` in the harness checkout: a
 * successful parse publishes `acpPlusStartup`, and the bridge row injects that
 * service, so `--help` prints usage without claiming stdio.
 *
 * @module dsh-acp-plus/app
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'acp-plus-startup'

/** Launcher service required before this app can parse its invocation. */
export const inject = ['cmdlineArgs']

/** Service the bridge row waits for before claiming stdio. */
export const ACP_EXT_STARTUP_SERVICE = 'acpPlusStartup'

/** Build this app's command line. Add flags here when a feature needs one. */
function acpPlusCommand(): Command {
  return new Command()
    .name('dsh --profile acp-plus')
    .description('Serve automation clients over the extended Agent Client Protocol stdio bridge.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile acp-plus     serve ACP until the client disconnects
`)
}

/**
 * Accept an invocation, publish readiness, and bind EOF to bounded shutdown.
 * @param ctx - plugin context carrying command-line and exit launcher values.
 */
export function apply(ctx: Context): void {
  const program = acpPlusCommand()
  program.action(() => {
    exitOnStdinEnd(ctx, 'acp-plus.stdin')
    ctx.provide(ACP_EXT_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
