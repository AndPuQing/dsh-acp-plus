# dsh-acp-plus

DeepSeek Harness（`dsh`）的**扩展 ACP 服务器**：一个 Cordis 插件 + 一个 profile
bundle，通过标准 [Agent Client Protocol](https://agentclientprotocol.com) stdio
向自动化客户端暴露 harness agent，并补上原生 `@deepseek-ai/dsh-acp` 没有实现的
功能。

- 原生实现：`../deepseek-harness/packages/acp/acp/`（automation-only，故意砍掉了
  `session/load`、`additionalDirectories`、terminals、elicitation、commands/modes）
- 本仓库：先逐字对齐原生得到基线，再按 `PLAN.md` 的里程碑逐个补齐
- 开发计划与缺口设计：**[PLAN.md](./PLAN.md)**

## 这不是什么

ACP 在 harness 里**不是可实现的 seam**——没有 `ctx.acp` 接口。它是一个
*protocol driver*，消费核心服务（`ctx.agents` / `ctx.sessions` /
`ctx.sessionPersistence` / `ctx.llm`），只拥有 wire。所以本项目不修改 harness，
只通过 profile patch 层挂载。

## 目录结构

```
.
├── package.json                  # bundle manifest (dsh.bundle.patch) + 插件入口导出
├── cordis.patch.yml              # 独立 profile 用的组合层（base + 本 bundle）
├── overlay-on-native-acp.yml     # 叠加到 shipped acp profile 用的覆盖层
├── scripts/
│   ├── check.mjs                 # tsc + 只报告本项目文件的诊断
│   └── run-tests.mjs             # esbuild 打包测试 → node --test（keyless）
├── src/
│   ├── index.ts                  # bridge 插件入口：wire、handler、teardown
│   ├── app.ts                    # startup provider：parseCmdline + stdin EOF
│   ├── config.ts                 # Config schema + 显式 resolveSpec()
│   ├── sessions.ts               # per-session 模块：admission / settlement / close
│   ├── codec.ts                  # turn ending → StopReason（纯函数）
│   ├── content.ts                # prompt 准入 + assistant block → ACP 内容（图片重读）
│   ├── mcp.ts                    # 标准 mcpServers → Agent-scoped MCP 客户端
│   ├── model-control.ts          # ctx.llm 目录 → ACP config options（含路由钉住）
│   ├── updates.ts                # session/event → session/update 投影
│   └── features/                 # 每个缺口一个模块，见 features/README.md
└── tests/                        # 测试策略见 tests/README.md
```

## 快速开始

前置：本机有可用的 `dsh`（从 harness checkout 用 `pnpm dsh ...` 也可以）。

```sh
# dev 依赖（esbuild/typescript/zod）。peer 包来自运行中的 dsh，不在这里安装；
# 若 pnpm 因未发布的 workspace peer 解析失败，用：
npm install --ignore-scripts --legacy-peer-deps

pnpm check                          # tsc，只报告本项目文件的诊断
pnpm test                           # keyless：esbuild 打包 tests/ → node --test
pnpm build                          # esbuild → lib/（@deepseek-ai/* 保持 external）

# 在 profile 里安装本 bundle（会以 @deepseek-ai/dsh-base 初始化 profile）
dsh plugin --profile acp-plus add .

# 验证组合层，再启动
dsh --profile acp-plus --dump-config | grep -A3 'dsh-acp-plus'
dsh --profile acp-plus
```

`dsh --profile acp-plus` 之后 stdout 只走 ACP JSON-RPC，stderr 是日志。用一个 ACP
客户端（例如 `@agentclientprotocol/sdk` 的 `ClientSideConnection`，或仓库里的
`packages/subagent/subagent-acp`）连接即可。

想直接替换 shipped `acp` profile 里的原生 bridge：

```sh
dsh --profile acp --patch ./overlay-on-native-acp.yml
```

## 配置

`Config`（`src/config.ts`）由 profile patch 提供：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | string | 回落 `agent-default-model` | 新建 agent 的 provider route（如 `deepseek-official`）；未设置时取运行 composition 的默认模型服务。 |
| `model` | string | 回落 `agent-default-model` | 新建 agent 的精确 model id（如 `deepseek-v4-flash`）；未设置时同上。 |
| `sessionListPageSize` | integer ≥ 1 | `100` | 一次 `session/list` 返回的最大条数。 |
| `enableSessionLoad` | boolean | `false` | 广告并服务 `session/load`（M2 转录回放）。 |
| `enableAdditionalDirectories` | boolean | `false` | 接受 `additionalDirectories`；根内经路径校验的写请求走预批准（M3）。 |
| `stream` | `Stream` | — | 仅测试用：注入内存传输；生产走 stdio，不进入 schema。 |

`provider`/`model` 未设置时，桥回落到 `ctx.agentDefaultModel`——Web Models 页写的
就是它，所以模型只需在 composition 里配一次（D10）。跨 profile 共享可放
`$DSH_HOME/cordis.patch.yml`（home 层，所有 profile 都应用，且优先于 profile 自己的
patch）。注意 DSH patch 对同一行的 `config` 是**整体替换**：若要覆盖 `acp-plus` 行，
必须把 `sessionListPageSize` / `enableSessionLoad` / `enableAdditionalDirectories`
一并重复，否则会静默回落默认值；只配模型时不需要碰这一行。

查看组合后的配置与 schema：

```sh
dsh --profile acp-plus --dump-config
dsh --profile acp-plus --dump-config-schema
```

## 安装与版本策略

- **本地 checkout**：先 `npm run build`（或 `pnpm build`），再
  `dsh plugin --profile acp-plus add .`（首次会以 `@deepseek-ai/dsh-base` 初始化 profile）。
- **git**：`dsh plugin --profile acp-plus add github:AndPuQing/dsh-acp-plus`；包里的
  `prepare` 会构建 `lib/`，pnpm ≥10 需要按提示把包加入 profile 的 `allowBuilds`。
- **覆盖原生 acp profile**：`dsh --profile acp --patch ./overlay-on-native-acp.yml`。
- **发布检查**：`npm run release:check` 校验 `lib/` 产物、manifest、profile 引用与
  peer 固定，并打印冒烟命令。装好后可用 `node scripts/smoke-client.mjs`
  （握手 + session 生命周期）或加 `--prompt "say hi"` 跑一轮真实模型回合；
  `DSH_BIN="pnpm dsh"` 可指向源码 checkout 的启动器。

### 在 Zed 里使用（含 Remote Development）

Zed 通过 `agent_servers` 启动外部 ACP agent。**远程项目里 agent 由远端 Zed server
执行**，所以配置要写进远端的 server settings：在 Zed 里运行 `zed: open server settings`
（对应远端 `~/.config/zed/settings.json`），或直接编辑该文件：

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

- `sh -lc` 用来拿到登录 shell 的 PATH（GUI/远端 server 的环境可能更窄）；也可以把
  `command` 写成 `dsh` 的绝对路径。
- 改完重连 remote 项目（或重启 remote server），在 Agent 面板的 agent 选择器里选
  `dsh-acp-plus`。
- 可用：模式（default/plan）、斜杠命令、`session/load` 历史回放、`ask_user_question`
  （客户端声明 form elicitation 时）。客户端终端不支持（D9）。
- 排查：远端 `~/.local/share/zed/logs/server-preview-*.log`；dsh 的 stderr 也汇总在那里。

所有 `@deepseek-ai/dsh-*` peer 固定为 `^0.2.0-rc.1`（本 checkout 的运行版本）。
preflight 对不匹配的运行版本会拒绝该 bundle，按诊断提示用
`dsh plugin allow-version <name>@<version>` 授予 exact-version 豁免。
这条约束由 `tests/packaging.test.ts` 直接调用 harness 自己的
`evaluatePluginCompatibility` 锁定。

## 硬约束（踩了就白干）

1. **不能有独立可执行入口。** harness 只允许经 `dsh --profile` 启动的应用
   （`docs/architecture.md#application-launch`）。服务器 = profile 里的一行。
2. **stdout 归协议。** 任何日志走 `ctx.logger`（stderr）；`ctx.effect` 的日志同理。
3. **函数插件用命名导出，禁止 `export default`。** Loader 会优先取 `.default` 并
   丢掉 `inject`/`Config`（`docs/postmortem/0001-acp-default-export-drops-inject.md`）。
4. **HMR 必须关。** stdio 连接下热重载会打断协议流（`cordis.patch.yml` 里已关）。
5. **peer 版本。** 所有 `@deepseek-ai/dsh-*` peer 必须匹配运行中的 dsh 版本（当前
   `^0.2.0-rc.1`，由 `tests/packaging.test.ts` 锁定）；不匹配的行会被 preflight
   整行 `disabled`，需要 `dsh plugin allow-version` 显式豁免。
6. **`session/new` 的 agent 不挂 preset。** ACP bundle 把面向模型的 row 留在 host
   层；需要 roster 的部署必须自己 join 一个 preset。

## 与原生实现的对照

| 本项目 | 原生（`packages/acp/acp/src/`） |
|---|---|
| `src/index.ts` | `index.ts` — 同样的 handler 集合、approval waterfall、quiesce、keyset cursor |
| `src/sessions.ts` | `session.ts` — admission / settlement / teardown（含原生 `resume`） |
| `src/codec.ts` | `codec.ts` — turn ending → StopReason |
| `src/content.ts` | `content.ts` — 准入、图片校验/重读、resource link 文本化 |
| `src/mcp.ts` | `mcp.ts` — stdio / streamable-http 校验与挂载 |
| `src/model-control.ts` | `model-control.ts` — 目录 → config options + `pinTurn`/`releaseTurn` |
| `src/updates.ts` | `updates.ts` — committed block → `session/update`（含 usage） |
| `src/app.ts` | `packages/bundle/acp-app/src/index.ts` |
| `src/features/session-load.ts` | 增量：原生没有 `session/load` 回放（M2） |
| `src/features/additional-directories.ts` | 增量：原生整包拒绝 `additionalDirectories`（M3） |
| `src/features/commands.ts` / `modes.ts` / `elicitation.ts` | 增量：命令、模式、elicitation（M5） |
| `src/features/steering.ts` | 增量：`_session/steering` 中途注入（zeron / org adapters 扩展，M7） |

进度以 [PLAN.md](./PLAN.md) 为准：

- **M0 / M1 已移植并锁住**：内容准入、MCP、路由钉住、stopReason、cursor，
  以及 `tests/parity.test.ts` 与原生逐条对照的 `session/update` 序列。
- **M2 已完成**：原生 `session/resume` 已接回；`session/load` 在
  `enableSessionLoad: true` 时广告并提供，按 seq 顺序重放持久化转录，随后可继续
  prompt（跨进程重启场景由 `tests/session-load.test.ts` 锁定）。回放不重放历史
  `usage_update`：它是当前压力而非转录事实，loader 在历史之后发一次最终读数。
- **M3 已完成（复用现有权限机制）**：`additionalDirectories` 严格授权（绝对路径、
  物理身份、去重、上限）后，站立 sandbox mode 不变；`write`/`edit` 的一次性
  escalation 只有在调用目标经物理 containment 验证落在声明根内时才由 bridge 自动
  放行，bash/越界路径/read-only 仍逐次问客户端。默认 `workspace-write` 部署下授权
  目录内的写文件真实可用，无需核心改动。
- **M4 评估后放弃（D8/D9）**：不支持 ACP 客户端终端。ACP 是一次性 exec 无 stdin，
  承载不了 DSH 持久 PTY 的语义；且 DSH 自带本地执行，标准用法（把 bash 路由到
  客户端）需要改核心。命令一律走本地 `bash`，与原生一致。
- **M5 已完成**：模式（`default`/`plan` + `set_mode`）、斜杠命令（列表发布 +
  `/name` 拦截执行）、elicitation（`ask_user_question` → ACP `elicitation/create`
  form，D2 定为标准方法；profile 补挂 `tool-ask-user`）。
- **M6 已完成（真机冒烟已过）**：peer 收紧到 `^0.2.0-rc.1` 并由 packaging 测试锁定
  preflight；分发形态为本地 checkout / git（`prepare` 构建，暂不发 npm）；README
  补齐 Config 与 `--dump-config-schema` 文档；`npm run release:check` 做静态发布检查。
  真机冒烟已在 dsh 0.2.0-rc.2 上跑通（keyless 生命周期、真实模型回合、跨进程
  `session/load` + 上下文恢复）；`provider`/`model` 未配置时回落 `agent-default-model`
  （D10），bundle patch 不再钉死模型路由。
- **M7 已完成**：`_session/steering` 中途注入（广告 `initialize._meta.steering`；运行中
  走 `agent.steer()`，空闲回 `promptRequired`/`noRunningTurn` 交回普通 prompt），由
  `tests/steering.test.ts` 锁定。

改这里之前先读原生对应文件；两边的语义必须可以逐段 diff。
