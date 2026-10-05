# dsh-acp-plus

An extended [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server
for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`),
packaged as an out-of-tree Cordis plugin and profile bundle.

It serves the standard ACP v1 surface and adds the capabilities the shipped
automation-only `@deepseek-ai/dsh-acp` bridge deliberately omits — transcript
replay, extra workspace roots, slash commands, plan mode, form elicitation, and
mid-turn steering — without changing the harness core.

```sh
dsh --profile acp-plus
```

## Features

- **Standard ACP v1** — sessions (`new` / `list` / `resume` / `close`), prompts
  and cancellation, model and reasoning-effort config options, MCP servers
  (stdio and streamable HTTP), images, permissions, usage, and tool updates.
- **`session/load`** — reopen a persisted session, replay its transcript, and
  continue prompting across process restarts.
- **Additional directories** — declare extra workspace roots on a session;
  verified single-target writes inside them are pre-approved through the
  harness's existing sandbox escalation, while everything else still asks the
  client.
- **Commands and modes** — publish the harness command list, execute `/name`
  without a model turn, and advertise `default` / `plan` modes.
- **Elicitation** — bridge `ask_user_question` to the standard ACP
  `elicitation/create` form when the client declares support.
- **Steering** — the `_session/steering` extension injects text into a live
  turn at its next step, and hands the text back when the turn already ended.
- **Default-model fallback** — with no provider/model in its own config, the
  bridge follows the composition's `agent-default-model` (the same default the
  dsh Web Models page writes).

## Requirements

- Node.js >= 22
- DeepSeek Harness (`dsh`) with a model route configured. The plugin's
  `@deepseek-ai/dsh-*` peers are pinned to the running harness version
  (`^0.2.0-rc.1`).

## Install

From GitHub:

```sh
dsh plugin --profile acp-plus add github:AndPuQing/dsh-acp-plus
```

From a local checkout:

```sh
dsh plugin --profile acp-plus add .
```

The build output (`lib/`) is committed, so neither route runs a build script.
After changing source, run `npm run build` and commit `lib/` with the change.

To replace the native bridge inside the shipped `acp` profile instead:

```sh
dsh --profile acp --patch ./overlay-on-native-acp.yml
```

## Usage

```sh
dsh --profile acp-plus
```

stdout carries only ACP JSON-RPC; diagnostics go to stderr. Connect any ACP
client to the process.

### Zed

Zed starts external agents through `agent_servers`. In a remote project the
agent runs on the remote Zed server, so the setting belongs in the remote
server settings (`zed: open server settings`, i.e. the remote
`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "dsh-acp-plus": {
      "type": "custom",
      "command": "/bin/sh",
      "args": ["-lc", "exec dsh --profile acp-plus"],
      "env": {}
    }
  }
}
```

`sh -lc` picks up the login shell's PATH; an absolute `dsh` path works too.
Reconnect the remote project and select `dsh-acp-plus` in the agent picker.
Modes, slash commands, `session/load` replay, and `ask_user_question` (when the
client declares form elicitation) are available; client terminals are
intentionally unsupported. Logs:
`~/.local/share/zed/logs/server-preview-*.log`.

## Configuration

The profile patch configures the bridge row:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `agent-default-model` | Provider route for new agents (e.g. `deepseek-official`). |
| `model` | string | `agent-default-model` | Exact model id (e.g. `deepseek-v4-flash`). |
| `sessionListPageSize` | integer >= 1 | `100` | Maximum sessions returned by one `session/list` page. |
| `enableSessionLoad` | boolean | `false` | Advertise and serve `session/load` transcript replay. |
| `enableAdditionalDirectories` | boolean | `false` | Accept `additionalDirectories` with containment-checked pre-approval. |

The shipped profile enables both `enableSessionLoad` and
`enableAdditionalDirectories`.

Inspect the composed configuration and its schema:

```sh
dsh --profile acp-plus --dump-config
dsh --profile acp-plus --dump-config-schema
```

### Models and credentials

`provider` / `model` are optional. When unset, the bridge follows
`agent-default-model` — the default model service the dsh Web Models page
writes — so a deployment configures its model once and every entry point
follows. Provider routes (`llm-pi-ai` providers) and the default model can be
shared across profiles by putting them in `$DSH_HOME/cordis.patch.yml`.

Note that a DSH patch replaces the whole `config` object of the row it targets:
overriding the `acp-plus` row requires restating `sessionListPageSize`,
`enableSessionLoad`, and `enableAdditionalDirectories`. Configuring only the
model does not touch that row.

API keys are home-level and shared by every profile
(`$DSH_HOME/.credentials.yaml`, written by the Web Models page or supplied
through the launch environment).

## Relationship to the native bridge

The shipped `@deepseek-ai/dsh-acp` is automation-only by design. This project
keeps its protocol semantics and extends them:

| Capability | `@deepseek-ai/dsh-acp` | `dsh-acp-plus` |
| --- | --- | --- |
| Sessions, prompts, cancel, MCP, images, config options | yes | yes (parity) |
| `session/resume`, `session/list`, `session/close` | yes | yes |
| `session/load` transcript replay | no | yes |
| `additionalDirectories` | no | yes |
| Commands, modes | no | yes |
| Form elicitation | no | yes |
| `_session/steering` | no | yes |

## Compatibility

- Standard ACP v1 plus the advertised session capabilities and the
  `_session/steering` extension; clients that do not know an extension ignore
  it.
- All `@deepseek-ai/dsh-*` peers are pinned to `^0.2.0-rc.1` and checked by
  dsh's plugin preflight. On a different harness version, grant the
  exact-version exemption the diagnostic describes
  (`dsh plugin allow-version <name>@<version>`).

## Development

```sh
npm run build          # esbuild -> lib/ (rebuild and commit after source changes)
npm run check          # tsc, project files only
npm test               # keyless: esbuild-bundled tests -> node --test
npm run release:check  # build + manifest, profile, and peer checks
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the repository layout, hard
constraints, and how the bridge tracks the native implementation.

## License

MIT. Portions are derived from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
Copyright (c) 2026 DeepSeek, used under the MIT License.
