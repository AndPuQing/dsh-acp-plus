#!/usr/bin/env node
/**
 * Release check: verify the built bundle, its manifest, and the profile patch
 * before installing into a profile.
 *
 * Runs after `npm run build` (the `release:check` script chains them). The
 * dsh-side preflight is additionally locked by `tests/packaging.test.ts`,
 * which runs the harness's own `evaluatePluginCompatibility`.
 */

import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const failures = []

const patch = manifest.dsh?.bundle?.patch
if (typeof patch !== 'string') failures.push('package.json is missing dsh.bundle.patch')

for (const file of ['lib/index.js', 'lib/app.js', patch, 'overlay-on-native-acp.yml', 'scripts/smoke-client.mjs']) {
  if (typeof file !== 'string') continue
  try {
    await access(join(root, file))
  } catch {
    failures.push(`missing built file: ${file}`)
  }
}

for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-') && range === '*') {
    failures.push(`${name} peer range must be pinned to the runtime it targets`)
  }
}

if (failures.length > 0) {
  console.error(`release:check failed:\n${failures.map(failure => `  - ${failure}`).join('\n')}`)
  process.exit(1)
}

console.log('release:check: bundle, manifest, and profile patch look installable\n')
console.log('Smoke test (requires a working dsh):')
console.log('  dsh plugin --profile acp-plus add .')
console.log('  dsh --profile acp-plus --dump-config | grep -A3 dsh-acp-plus')
console.log('  dsh --profile acp-plus --dump-config-schema')
console.log('  node scripts/smoke-client.mjs             # handshake + session lifecycle')
console.log('  node scripts/smoke-client.mjs --prompt "say hi"   # one model turn')
console.log('\nIf preflight rejects the dsh peer range, grant the exact-version exemption')
console.log(`for ${manifest.name}@${manifest.version} on the running dsh (see the diagnostic).`)
