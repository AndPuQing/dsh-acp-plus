/**
 * Release-manifest lock (PLAN.md M6).
 *
 * Two properties must hold before the bundle is installed into a profile:
 * dsh's own plugin-compatibility preflight accepts every `@deepseek-ai/dsh-*`
 * peer against the runtime the manifest targets, and the bundle manifest plus
 * profile patch point at entries the package actually ships.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import semver from 'semver'
import { evaluatePluginCompatibility } from '../../deepseek-harness/packages/boot/app-boot/src/plugin-compatibility.ts'

interface BundleManifest {
  name: string
  version: string
  private?: boolean
  files: string[]
  exports: Record<string, string>
  dsh: { bundle: { patch: string } }
  peerDependencies: Record<string, string>
}

/** Read and parse one JSON file under the project root. */
async function projectJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), ...segments), 'utf8')) as T
}

test('the bundle manifest passes the dsh plugin-compatibility preflight', async () => {
  const manifest = await projectJson<BundleManifest>('package.json')
  const dshPeers = Object.entries(manifest.peerDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  for (const [name, range] of dshPeers) {
    assert.notEqual(range, '*', `${name} must carry a concrete runtime range`)
  }
  assert.equal(new Set(dshPeers.map(([, range]) => range)).size, 1,
    'all @deepseek-ai/dsh-* peers must target the same runtime range')

  // Validate against the sibling checkout when it satisfies the declared
  // range. An older checkout (a common state while the target is a
  // prerelease) falls back to the range's floor, so the test still guards the
  // manifest's stated target instead of silently validating an old runtime.
  const firstPeer = dshPeers[0]
  assert.ok(firstPeer, 'the manifest must declare at least one @deepseek-ai/dsh-* peer')
  const range = firstPeer[1]
  const checkout = await projectJson<{ version: string }>(
    '..', 'deepseek-harness', 'packages', 'boot', 'app-boot', 'package.json',
  )
  const floor = semver.minVersion(range)
  assert.ok(floor, `${range} must have a lowest admitted version`)
  const runtime = semver.satisfies(checkout.version, range, { includePrerelease: true })
    ? checkout.version
    : floor.version
  assert.equal(evaluatePluginCompatibility(manifest, {}, runtime), undefined)
})

test('the manifest ships its entries and the profile patch references them', async () => {
  const manifest = await projectJson<BundleManifest>('package.json')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./app'], './lib/app.js')
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('overlay-on-native-acp.yml'))

  const patch = await readFile(join(process.cwd(), manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /name: 'dsh-acp-plus'/)
  assert.match(patch, /name: 'dsh-acp-plus\/app'/)
  // Client terminals are deliberately unsupported (PLAN D9).
  assert.doesNotMatch(patch, /enableTerminals/)
})
