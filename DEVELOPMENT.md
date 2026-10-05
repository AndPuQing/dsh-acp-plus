# Development

Contributor notes for `dsh-acp-plus`. The user-facing documentation lives in
[README.md](./README.md); the milestone and decision record lives in
[PLAN.md](./PLAN.md) (Chinese).

## What this is

ACP is not an implementable seam in DeepSeek Harness — there is no `ctx.acp`
interface. The bridge is a *protocol driver*: it consumes core services
(`ctx.agents`, `ctx.sessions`, `ctx.sessionPersistence`, `ctx.llm`, …) and owns
only the wire. Nothing in the harness core is modified; the project mounts as a
profile patch layer on top of `@deepseek-ai/dsh-base`.

The baseline is ported file-by-file from the native
`packages/acp/acp/src/` implementation and then extended, so the two can be
diffed section by section. Read the native counterpart before changing a ported
module.

## Repository layout

```
.
├── package.json                  # bundle manifest (dsh.bundle.patch) + plugin entry exports
├── cordis.patch.yml              # standalone profile layer (base + this bundle)
├── overlay-on-native-acp.yml     # overlay for the shipped acp profile
├── scripts/
│   ├── check.mjs                 # tsc, project files only
│   ├── release-check.mjs         # lib/manifest/profile/peer checks
│   ├── run-tests.mjs             # esbuild-bundled tests -> node --test (keyless)
│   └── smoke-client.mjs          # end-to-end ACP client against a real dsh
├── src/
│   ├── index.ts                  # bridge plugin entry: wire, handlers, teardown
│   ├── app.ts                    # startup provider: parseCmdline + stdin EOF
│   ├── config.ts                 # Config schema + explicit resolveSpec()
│   ├── sessions.ts               # per-session module: admission / settlement / close
│   ├── codec.ts                  # turn ending -> StopReason (pure)
│   ├── content.ts                # prompt admission + assistant block -> ACP content
│   ├── mcp.ts                    # standard mcpServers -> agent-scoped MCP clients
│   ├── model-control.ts          # ctx.llm catalog -> ACP config options (route pinning)
│   ├── updates.ts                # session/event -> session/update projection
│   └── features/                 # one module per gap closed vs native
└── tests/                        # test strategy in tests/README.md
```

## Hard constraints

Breaking one of these breaks the bridge in ways that are hard to diagnose.

1. **No standalone executable entry.** The harness only launches applications
   through `dsh --profile`; the server is one row in a profile.
2. **stdout is protocol-only.** Every log goes through `ctx.logger` (stderr),
   including `ctx.effect` logs.
3. **Function plugins use named exports; never `export default`.** The loader
   prefers `.default` and drops `inject` / `Config`.
4. **HMR stays off.** Hot reload over a stdio connection breaks the protocol
   stream; `cordis.patch.yml` disables it.
5. **Peer versions.** Every `@deepseek-ai/dsh-*` peer must match the running
   harness version (currently `^0.2.0-rc.1`, locked by
   `tests/packaging.test.ts`). A mismatched row is disabled by the plugin
   preflight and needs an explicit `dsh plugin allow-version` exemption.
6. **`session/new` agents mount no preset.** The ACP bundle keeps model-facing
   rows in the host layer; a deployment that needs a roster joins a preset
   itself.

## Native parity

| This project | Native (`packages/acp/acp/src/`) |
| --- | --- |
| `src/index.ts` | `index.ts` — handler set, approval waterfall, quiesce, keyset cursor |
| `src/sessions.ts` | `session.ts` — admission / settlement / teardown (including `resume`) |
| `src/codec.ts` | `codec.ts` — turn ending to `StopReason` |
| `src/content.ts` | `content.ts` — admission, image validation/re-read, resource-link text |
| `src/mcp.ts` | `mcp.ts` — stdio / streamable-HTTP validation and mounting |
| `src/model-control.ts` | `model-control.ts` — catalog to config options + route pinning |
| `src/updates.ts` | `updates.ts` — committed block to `session/update` (with usage) |
| `src/app.ts` | `packages/bundle/acp-app/src/index.ts` |
| `src/features/session-load.ts` | Increment: native has no `session/load` replay |
| `src/features/additional-directories.ts` | Increment: native rejects `additionalDirectories` |
| `src/features/commands.ts`, `modes.ts`, `elicitation.ts` | Increment: commands, modes, elicitation |
| `src/features/steering.ts` | Increment: `_session/steering` mid-turn injection |

`tests/parity.test.ts` drives both bridges over the same scripted input and
compares the committed `session/update` sequences.

## Status

Milestones and decisions are tracked in [PLAN.md](./PLAN.md). Current state:

- M0–M1 — native parity (content admission, MCP, route pinning, stop reasons,
  cursors) locked by the parity suite.
- M2 — `session/load` replay plus `session/resume`, locked across simulated
  process restarts.
- M3 — `additionalDirectories` authorization and containment-checked
  pre-approval, reusing the existing escalation mechanism.
- M4 — client terminals deliberately unsupported (one-shot exec cannot carry
  persistent PTY semantics).
- M5 — commands, plan mode, form elicitation.
- M6 — release/packaging; `lib/` is committed so git installs need no build
  step; peers pinned and checked.
- M7 — `_session/steering` mid-turn injection.

## Development commands

```sh
# Dev dependencies (esbuild, TypeScript, zod). Peer packages come from the
# running dsh, not from here; if pnpm fails on unpublished workspace peers:
npm install --ignore-scripts --legacy-peer-deps

npm run check          # tsc, project files only (paths resolve to ../deepseek-harness)
npm test               # keyless: esbuild-bundled tests -> node --test
npm run build          # esbuild -> lib/ (@deepseek-ai/* stay external)
npm run release:check  # build + lib/manifest/profile/peer checks

# Install into a profile and inspect the composition
dsh plugin --profile acp-plus add .
dsh --profile acp-plus --dump-config | grep -A3 'dsh-acp-plus'
dsh --profile acp-plus --dump-config-schema

# End-to-end smoke against a real dsh (DSH_BIN can point at a source checkout)
node scripts/smoke-client.mjs                     # handshake + session lifecycle
node scripts/smoke-client.mjs --prompt "say hi"   # one real model turn
DSH_BIN="pnpm dsh" node scripts/smoke-client.mjs
```

The TypeScript `paths` map points at the sibling `../deepseek-harness` checkout,
so `npm run check` and `npm test` typecheck and bundle against harness source.
Runtime never uses those paths; a profile resolves the peers from its own dsh
installation.

## Distribution

`lib/` is committed. Any source change must be followed by `npm run build` and a
commit of the rebuilt `lib/`, or git installs will run stale code. `npm run
release:check` rebuilds before validating, so run it before pushing.

`private: true` keeps the package off npm for now. If it is published later,
pick a scope and keep the committed build output in `files`.
