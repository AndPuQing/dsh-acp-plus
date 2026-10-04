#!/usr/bin/env node
/**
 * Type check the project.
 *
 * The dev tsconfig extends the sibling harness checkout so every transitive
 * `@deepseek-ai/*` import typechecks against source. That also surfaces the
 * checkout's own source diagnostics, which are noise for this repository (they
 * are compiled by the harness's project references, not here). Report only
 * diagnostics in project files and global configuration diagnostics.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
})

if (result.error !== undefined) {
  console.error(`check: failed to run tsc: ${result.error.message}`)
  process.exit(1)
}

const output = `${result.stdout}${result.stderr}`
const diagnostics = output.split('\n').filter(line => line.includes('error TS'))
const projectDiagnostics = diagnostics.filter(line => !line.startsWith('../deepseek-harness/'))

if (projectDiagnostics.length > 0) {
  console.error(projectDiagnostics.join('\n'))
  process.exit(1)
}

console.log(`check: 0 project errors (${diagnostics.length} sibling-checkout diagnostics ignored)`)
