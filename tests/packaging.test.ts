/**
 * Release-manifest lock (PLAN.md M6).
 *
 * Two properties must hold before the bundle is installed into a profile:
 * dsh's own plugin-compatibility preflight accepts every `@deepseek-ai/dsh-*`
 * peer against the runtime this checkout targets, and the bundle manifest plus
 * profile patch point at entries the package actually ships.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
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
  // The runtime targeted by this checkout; a profile on another version needs
  // `dsh plugin allow-version`.
  const runtime = await projectJson<{ version: string }>(
    '..', 'deepseek-harness', 'packages', 'boot', 'app-boot', 'package.json',
  )

  assert.equal(evaluatePluginCompatibility(manifest, {}, runtime.version), undefined)
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assert.notEqual(range, '*', `${name} must carry a concrete runtime range`)
    }
  }
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
