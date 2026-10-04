#!/usr/bin/env node
/**
 * Test runner: bundle each TypeScript test with esbuild, then execute the
 * emitted JavaScript with Node's built-in test runner.
 *
 * Tests import `../src/*.ts` and (type-)import `@deepseek-ai/*` peers. The
 * tsconfig `paths` map resolves those peers to the sibling harness checkout, so
 * esbuild inlines exactly what each test needs and the suite runs keyless,
 * without a `dsh` installation or network access.
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(root, 'tests')
const outRoot = join(root, '.test-build')
const outDir = join(outRoot, 'tests')

const entries = (await readdir(testsDir))
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join(testsDir, name))

if (entries.length === 0) {
  console.error('run-tests: no tests/*.test.ts files found')
  process.exit(1)
}

await rm(outRoot, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
// Some bundled harness modules read their own package.json relative to the
// bundle (dsh-llm attribution reads `../package.json`); give the bundle root a
// package identity so that read resolves instead of crashing the test run.
await writeFile(join(outRoot, 'package.json'), JSON.stringify({ name: 'dsh-acp-plus-tests', version: '0.0.0', type: 'module' }))

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  absWorkingDir: root,
  tsconfig: join(root, 'tsconfig.json'),
  // Harness sources resolved through tsconfig `paths` remain bare-import
  // consumers (zod, …); resolve those from this project's dev dependencies.
  nodePaths: [join(root, 'node_modules')],
  logLevel: 'warning',
  alias: {
    // Optional/native transport stacks the bridge test never exercises.
    '@deepseek-ai/dsh-mcp-client': join(root, 'tests', 'stubs', 'mcp-client.ts'),
    '@deepseek-ai/node-addon-system/flock': join(root, 'tests', 'stubs', 'flock.ts'),
    '@modelcontextprotocol/client': join(root, 'tests', 'stubs', 'empty.ts'),
    'undici': join(root, 'tests', 'stubs', 'empty.ts'),
    'koffi': join(root, 'tests', 'stubs', 'empty.ts'),
  },
})

const outputs = entries.map(entry => join(outDir, basename(entry).replace(/\.ts$/, '.js')))

const child = spawn(process.execPath, ['--test', ...outputs], { stdio: 'inherit', cwd: root })
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
