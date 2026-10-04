# 开发计划 — dsh-acp-plus

目标：在**不改动 harness 核心**的前提下，交付一个比原生
`@deepseek-ai/dsh-acp` 更完整的 ACP 服务器，并保证二者的既有语义可逐段 diff。

---

## 0. 定位与边界

| 项 | 决定 |
|---|---|
| 形态 | 一个 Cordis 插件 + 一个 bundle（`dsh.bundle.patch`），不是独立进程 |
| 启动 | `dsh --profile acp-plus`（唯一允许的 Node 应用启动方式） |
| 挂载 | profile patch 层：`base` → `dsh-acp-plus`（或 `acp` → overlay） |
| 拥有的服务 | 无。只消费 `agents` / `sessions` / `sessionPersistence` / `llm` / `approval` |
| 不碰 | agent-loop、`SessionEventMap`、核心 Service Definition |
| 基线 | 先与原生逐字对齐（M0–M1），再叠加增量（M2–M5） |

**非目标**：重写 agent loop；给 DSH 增加新的持久化事件类型；把 Web/Desktop 的
presentation 数据塞进 wire；提供 DSH 专属协议扩展（客户端只应看到标准 ACP v1 +
我们明确广告的扩展）。

---

## 1. 里程碑总览

| # | 里程碑 | 交付 | 验收（keyless 可跑） |
|---|---|---|---|
| M0 | 基线可跑 | 基本 handler + 投影 + 权限 + teardown | 官方 SDK 客户端完成一轮 text prompt |
| M1 | 与原生对齐 | content/mcp/codec/model-control 完整 | 既有 ACP e2e 场景在本服务器下等价通过 |
| M2 | 会话生命周期 | `session/load` 回放、`resume`、cursor 分页 | 重启进程后可恢复并回放历史 |
| M3 | 多工作区 | `additionalDirectories` + 信任模型 | 未授权目录请求失败；授权目录内工具可用 |
| M4 | 终端 | ~~ACP client terminal~~ 评估后放弃（D8/D9，实现已删除） | — |
| M5 | 交互扩展 | elicitation(`ctx.userQuestions`)、commands、modes | ✅ 已落地并测试 |
| M6 | 发布 | 打包、版本、兼容策略、文档 | 干净环境 `dsh plugin add` 后可直接用 |
| M7 | steering 扩展 | `_session/steering` 中途注入（zeron / org adapters） | ✅ 已落地并测试 |

依赖顺序：M0 → M1 必须完成才动 M2+（否则增量无法与基线区分）。M3/M4/M5 相互独立，
可并行。

---

## 2. 里程碑详情

### M0 — 基线可跑

**范围**：`initialize` / `authenticate` / `session/new` / `session/list` /
`session/close` / `session/set_config_option` / `session/prompt` /
`session/cancel`；`agent_message_chunk`、`tool_call`、`tool_call_update` 投影；
一次性权限应答；整套 quiesce。

**对照移植**：

- `src/index.ts` ← 原生 `index.ts`（handler 表、approval waterfall、`quiesce()`）
- `src/sessions.ts` ← 原生 `session.ts`（`InflightPrompt`、admission → followup →
  `turn/end` 结算）
- `src/updates.ts` ← 原生 `content.ts` + `session.ts#onSessionEvent`
  （`toolCallUpdate` / `toolResultUpdate` / assistant block 转换）
- 新增 `src/codec.ts` ← 原生 `codec.ts`（turn ending → `StopReason` 纯函数）

**完成记录（2025-09，代码已落地）**：

1. ✅ `updates.ts` 现在投影 committed `message.content`（与原生一致）：reasoning →
   `agent_thought_chunk`，text/image → `agent_message_chunk`，`usage_update` 需要
   `tokenMeter` 与 `contextWindow` 同时存在；tool result 复用同一内容编解码并映射
   `isError` → `failed`。
2. ✅ 新增 `codec.ts`；`settleAfterQuiescence()` 按原生优先级结算：
   `cancelRequested` → `outputError` → `agentError` → `turn/end.reason`
   （`error` 拒绝，其余走 codec），并等待 `agent.whenIdle()` + output tail。
3. ✅ admission 移植原生两阶段实现：`admissionDone`/`admissionController`、
   块级校验（text/resource_link/image；audio/resource 显式 invalid）、abort 前后
   的竞态处理；`AcpPlusContentError.kind` 映射 invalid/internal。

`tests/bridge.test.ts` 用官方 SDK 跑通：握手、`session/new` → prompt → 提交输出 →
`end_turn`、`session/cancel` → `cancelled`、非广告内容拒绝、close 后 `list` 分页。

**验收**：用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 连上本服务器，
`initialize` → `session/new` → `session/prompt("say hi")` → 收到
`agent_message_chunk` → `stopReason` 正确；`session/cancel` 中途取消得到
`cancelled`。

**测试**：`tests/bridge.test.ts`（InMemory stream + mock adapter，不联网）——已落地并通过。

---

### M1 — 与原生对齐

**范围**：把原生 automation contract 的全部可观察行为补齐，确保"更完整"不是"更不兼容"。

| 项 | 来源 | 要点 | 状态 |
|---|---|---|---|
| 内容准入 | 原生 `content.ts` | text 合并、`resource_link` 转 `[resource_link name=… uri=…]`、图片校验与持久化、exact route 图片能力复核 | ✅ `src/content.ts` |
| MCP | 原生 `mcp.ts` | `session/new` 的 stdio / streamable-http 条目校验、挂载失败回滚未发布 agent | ✅ `src/mcp.ts`（挂载在 `agents.create.setup` 内） |
| 路由钉住 | 原生 `model-control.ts` | `snapshot()` → `onInboxClaimed` → `pinTurn` → `turn/end` → `releaseTurn` | ✅ |
| stopReason | 原生 `codec.ts` | 取消 / 提交失败 / Agent 失败 / 正常结束的优先级 | ✅ |
| 列表分页 | 原生 `index.ts` | base64url keyset cursor、`session.list` 的 `cwd` 物理身份过滤 | ✅ |
| 更新串行 | 原生 `session.ts` | 单条 `outputTail`，失败只告警不断链 | ✅ |

**完成记录（2025-09）**：`tests/parity.test.ts` 已落地。共享 harness 支持
`{ bridge: 'ext' | 'native' }`：同一个 Context 装置分别挂本仓库 bridge 或原生
`@deepseek-ai/dsh-acp`，用同一脚本驱动，逐条 compare `session/update`（随机
`messageId` 归一为位置 token）与 stopReason/错误。场景：标准能力握手、text 一轮、
max-tokens、reasoning + tool 生命周期 + usage + 收尾文本、cancel 中途、provider error。
测试链锁是真的：临时把 `tool_call.kind` 改成其他值，parity 立即变红（已验证）。

**验收**：原生 ACP e2e 场景（握手、取消、权限通过/拒绝、图片卸载、MCP、多会话）
在本服务器下逐一通过；两边的 `session/update` 序列逐条相等。

**测试**：单测（`packages/acp/acp/tests` 的等价物）+ keyless profile e2e
（对照 `apps/cli/tests/profiles/acp/tests/control-surface.e2e.ts` 的形式）。

---

### M2 — 会话生命周期（第一个相对增量）

**范围**：

1. `session/load`：读持久化事件流，按 live 路径的投影规则回放（`features/session-load.ts`）
2. `session/resume` 完整实现（原生已有，基线里被 stub）
3. ~~`session/list` cursor 续页~~ ✅ 已在 M1 移植（base64url keyset cursor）
4. **仅在我的 session 上回放**：被别的 live session 占用的 id 必须报错

**完成记录（2025-09，代码已落地）**：

1. ✅ `src/features/session-load.ts`：`persistence.open(id, 'read')` 读取完整日志，
   按 seq 顺序用 live 同一套投影（`assistantUpdates`/`toolCallUpdate`/`toolResultUpdate`）
   发送；图片仍经 attachment store 重读校验。
2. ✅ `session/resume`：`AcpPlusSession.resume` + `selectionFor`（恢复日志里的 route）
   按原生移植；index 的 `resumeSession` 含 `activating` 保留集、stat/子代理/cwd 校验。
3. ✅ `session/load`：先纯读回放，再 resume 组合 live Agent，最后发布一次当前
   `usage_update`；发布前 id 不在 `sessions` 里，并发 prompt 无法与回放交错。
4. ✅ `initialize` 仅在 `enableSessionLoad` 为真时广告 `loadSession: true`；
   `sessionCapabilities.resume` 从此始终广告（handler 已实现）。

**决策记录（D6）**：回放不重放历史 `usage_update`。它是「当前 context 压力」而非
转录事实，只有折叠完整日志的 live 度量才有意义；loader 在历史之后发布一次最终读数。
单轮历史下重放序列与实时序列完全相等（测试锁定）。

**验收**：进程 A 跑一轮 prompt 后退出；进程 B 启动，`session/load` 得到与 A 中
相同的 `session/update` 序列（重放稳定性），随后可继续 prompt。

**测试**：`tests/session-load.test.ts`：跨 harness（共享 persistence root，模拟重启）
重放 == 实时序列、随后继续 prompt；occupied id / 未开启 / 非法 id / cwd 不匹配拒绝；
`resume` 不回放；另一 owner 持锁时 load 失败。

**关键约束**：回放走 per-session 的同一条 output tail；回放期间不接受新 prompt
（或明确串行化），否则客户端会看到乱序历史。图片从 attachment store 重读并做
完整性校验，与 live 路径一致。

**验收**：进程 A 跑一轮 prompt 后退出；进程 B 启动，`session/load` 得到与 A 中
相同的 `session/update` 序列（重放稳定性），随后可继续 prompt。

**测试**：新增快照场景（重放 == 原序列），keyless 录制。

---

### M3 — `additionalDirectories` + 信任模型

**范围**：`features/additional-directories.ts`。这不只是"允许更多目录"，而是扩展
agent 可达面，必须：

1. 每个条目按 `cwd` 相同的规则授权（绝对路径、物理身份）
2. 转化为 fs/sandbox 策略（`ctx.sandbox` / `ctx.permissionPresets`），越界即
   `session/new` 失败，不允许静默降级
3. 把授权集合写进 session header，resume 时不得扩大

**完成记录（2025-09，代码已落地）**：

- ✅ D1 定为**会话级**：ACP 客户端是可信自动化对端，像声明 `cwd` 一样在
  `session/new` / `load` / `resume` 上声明根集合。
- ✅ `authorizeAdditionalDirectories`：绝对路径 + `realpath` 物理身份 + 必须为已存在
  目录；去重、剔除与 cwd 相同的条目；上限 16 条；非法条目 → invalid params。
- ✅ **复用现有权限机制而不是放宽沙箱**：站立 sandbox 保持原 mode；声明集只用于
  预批准。`write`/`edit` 的一次性 escalation（`sandbox_permissions`）到达
  `ctx.approval` 时，bridge 确认该调用已记录的 `file_path` 物理解析后落在声明根内，
  就直接回 `allowed-once`（客户端已在会话级给过授权）；其余一律照旧转发给客户端：
  bash（命令不可验证）、越界路径、`read-only` 站立策略、非 escalation 的
  `tools/pre-execute` ask。
- ✅ 每个接受的根作为 per-agent runtime context 注入（`acp-plus:additional-directories`），
  告诉模型在该根内写文件要带 `sandbox_permissions="danger-full-access"` + 理由。
- ✅ `initialize` 在 `enableAdditionalDirectories` 开启时广告
  `sessionCapabilities.additionalDirectories`；load/resume 重复声明时重新校验。
- ✅ 默认 `workspace-write` 部署下，授权根内的一次 `write`/`edit` 真实可用
  （`danger-full-access` 只作用于该次调用，且调用路径已过 containment 检查），
  不需要任何核心改动。

**边界与残余风险**：

- `danger-full-access` 是单次调用的 mode 放宽；`write`/`edit` 是单目标工具，实际
  可达面被调用路径的 containment 检查限定。bash 命令无法静态验证，额外根内的
  shell 写入仍需客户端逐次批准（或用户自行切 session preset）。
- `read-only` 站立策略不自动预批准，仍由人决定。
- 授权集合不持久化：load/resume 由客户端重新声明并重新校验；丢弃/改变集合只会
  缩小自动批准范围，不会扩大。
- 残余 TOCTOU：containment 在批准时解析，工具执行前路径可能被换链；与
  `fs-sandbox` 记录的同类残余一致。

**上游可选增强（D7）**：`SandboxExecutionPolicy.additionalRoots` + `writableRoots()` +
`sandbox-local` profile + terminal/bash workdir，以及持久化记录（header 字段或可
`ignorable` 的事件）。当前设计不需要它们；有了之后可把「每次调用放宽」升级成
「策略内多根」，行为面不变。

**验收**：拒绝未授权/非法目录；授权目录内的 `write`/`edit` 真实可用且不额外打扰
客户端；越界/bash/read-only 仍走客户端逐次批准；load/resume 重新校验。

**测试**：`tests/directories.test.ts`：授权/去重/物理身份/上限与 containment 单测；
未开启拒绝、广告与接受、resume/load 重新校验；真实 `write` 工具 e2e：根内 escalation
自动放行且文件落盘、根外仍向客户端发 permission 请求、read-only 仍向客户端发请求。

---

### M4 — 终端（ACP client terminal）——评估后放弃（D8/D9）

**结论：不实现、不支持客户端终端，相关代码已删除。** 理由：

1. ACP 客户端终端每个 `terminal/create` 只跑一条命令，且协议**没有 stdin**；DSH 的
   `ctx.terminals` 是持久交互 PTY（`terminal_open`/`terminal_send`，stdin/scrollback/
   signal）。两者语义不匹配，做 backend 会让 `terminal_open` 对模型说谎。
2. DSH 永远自带本地命令执行（`bash` + 沙箱），而 ACP 客户端终端的标准用法是把
   **常规命令执行**路由到客户端——这需要替换 `ctx.shell`（每 context 单实现），
   属于改核心，不值得。
3. 单独加一个 `client_terminal` 工具只会让模型的选择更模糊、扩大信任面，实测收益
   有限；原生 bridge 也完全忽略客户端终端，保持对齐更干净。

（历史实现与测试曾于 2025-09 落地并验证过 create/wait/output/release、取消 kill、
能力门控，随后按上述结论整体删除；PLAN 保留此记录以免重复评估。）

---

### M5 — 交互扩展

**范围**：elicitation / commands / modes 三块，均只对本 bridge 拥有的 session 生效。

**完成记录（2025-09，代码已落地；D2 已决）**：

- ✅ **elicitation**（`features/elicitation.ts`）：注册 `user-questions/request`
  waterfall 监听，用 `ownedRecord(agent)` 只认领自己的 session；把 DSH 问题集转成一个
  ACP **标准** `elicitation/create` form（`mode: 'form'`）：单选 → 带标题的 string
  `oneOf`，多选 → string array enum，自由文本 → string，每个带选项的问题额外给一个
  `__other` 自由文本字段。答案映射回 `{id, selected, custom}`；`decline`/`cancel`
  让工具以错误结算；提问 signal 中止时自己 race abort（SDK 只在 peer 应答后才结算被
  取消的请求），断连/取消不会挂死工具。客户端必须在 `initialize` 声明
  `clientCapabilities.elicitation.form`，否则 `next()` 交回链，工具照旧以 NO_PROVIDER
  失败。profile 增加 `tool-ask-user` 行，让 `ask_user_question`（以及 plan-mode 的
  `exit_plan_mode` 评审）真正可用。
- ✅ **commands**（`features/commands.ts`）：`session/new|load|resume` 响应之后
  （`setTimeout(0)`，确保客户端已知 sessionId）推 `available_commands_update`；
  `commands/change` 时对每个 live session 重推。prompt 若为纯文本、以 `/` 开头且命中
  `ctx.commands.find(agent, name)`，直接走 `ctx.commands.execute`，不产生模型回合，
  返回 `end_turn`；`command/run`/`command/done` 事件投影成 `user_message_chunk`/
  `agent_message_chunk`，回放与实时一致。未命中或含非文本块的 `/...` 仍走模型。
- ✅ **modes**（`features/modes.ts`）：挂载 plan-mode 时 session 响应带
  `modes`（`default`/`plan`），未挂载时完全省略 `modes`（响应与原生逐字段一致，
  `set_mode` 拒绝一切非 default）；`session/set_mode` → `ctx.planMode.set`，
  `plan/mode` 事件 → `current_mode_update`；当前模式从 `plan` projection 折叠读取，
  resume 后自然恢复。plan mode 只是提示轴，不触碰 approval/sandbox（有测试锁定）。
- 三块都是纯增量：没有 deployment gate（commands/modes 客户端会忽略不认识的 update；
  elicitation 由客户端能力门控），与原生 parity 场景无交集。

**验收**：model 发起的用户提问能被客户端回答并回到工具结果（decline/中止不挂死）；
命令列表随注册变化更新且命令不产生模型回合；模式切换可见、resume 后保持、且不削弱
审批/沙箱轴。

**测试**：`tests/elicitation.test.ts`（表单构建/答案映射单测 + accept/decline/无能力/
中止 e2e）、`tests/commands.test.ts`（列表、拦截执行、未知命令回落、重推）、
`tests/modes.test.ts`（默认+plan、set_mode 通知、resume 恢复、无 plan-mode 时单模式、
沙箱轴不变）。

---

### M6 — 发布

**完成记录（2025-09）**：

- ✅ **peer 收紧**：所有 `@deepseek-ai/dsh-*` peer 从 `*` 改为 `^0.2.0-rc.1`（本
  checkout 的运行版本）；`@deepseek-ai/cordis` / `schemastery` 保持 `*`（preflight
  只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）。`tests/packaging.test.ts` 直接
  调用 harness 自己的 `evaluatePluginCompatibility(manifest, {}, runtimeVersion)`，
  锁定「preflight 通过」且 `dsh-*` peer 没有 `*`；临时改一个不兼容版本会立即变红。
  其他运行版本按诊断提示 `dsh plugin allow-version <name>@<version>` 授予
  exact-version 豁免。
- ✅ **分发形态（D5）**：保持 `private: true`，以**本地 checkout / git** 分发；
  `lib/` 构建产物随仓库提交，git 安装不需要 build script（pnpm ≥10 不再拦
  `allowBuilds`）。改源码后必须 `npm run build` 并把 `lib/` 一起提交。npm 发布留到
  选定 scope 后再做。`files` 补入 `overlay-on-native-acp.yml`；`engines.node >= 22`。
- ✅ **文档**：README 增加完整 Config 字段表与 `--dump-config` /
  `--dump-config-schema` 命令；schema 字段带 `.description(...)`，dump 可读。
- ✅ **静态发布检查**：`scripts/release-check.mjs`（`npm run release:check` =
  build + check）校验 lib 产物、`dsh.bundle.patch`、profile 引用与 peer 固定，并打印
  冒烟命令。
- ✅ **真机冒烟已跑通**（dsh 0.2.0-rc.2，隔离 `DSH_HOME`）：`dsh plugin --profile acp-plus add .`
  → keyless 生命周期 → `/plan` 命令与模式 → 真实模型回合（`local/deepseek-v4.1-flash`）
  → 跨进程 `session/load` 回放 + 上下文恢复。
- ✅ **默认模型回落（D10）**：`provider`/`model` 未配置时桥取 `ctx.agentDefaultModel`；
  bundle patch 不再钉死 `deepseek-official/deepseek-v4-flash`，用户层 patch 不再需要
  覆盖 `acp-plus` 行（因此不会因整体替换丢掉 `enable*` 字段）。由
  `tests/default-model.test.ts` 锁定。

---

### M7 — `_session/steering`（增量）

**范围**：`features/steering.ts` + `AcpPlusSession.steer()`。扩展定义于
agentclientprotocol org adapters，zeron 的 ACP driver 消费：客户端在
`initialize._meta.steering.supported` 为真时，用 `_session/steering` 在回合进行中
注入文本（带 `_meta.steering.idleBehavior: "promptRequired"`）。

**完成记录（2025-10）**：

- ✅ **广告**：`initialize` 结果带 `_meta: { steering: { supported: true } }`；客户端
  只有看到它才会走扩展，因此无需 deployment gate（同 commands/modes 的增量性质）。
- ✅ **准入**：`features/steering.ts` 只接受 text 块；非文本/空文本不报错，直接回
  `{ outcome: 'promptRequired', reason: 'noRunningTurn' }`，把内容交回正常
  `session/prompt` 准入（富内容校验归 content.ts）。
- ✅ **注入**：`AcpPlusSession.steer()` 仅在本 bridge 有 in-flight prompt 且
  `agent.status === 'running'` 时调用 DSH core 的 `agent.steer()`（next-step 邮箱，
  下个 step 边界被模型看到）；空闲/取消中/无 prompt 时回 `promptRequired`，避免
  `agent.steer()` 在空闲 driver 上唤醒一个未跟踪的 turn。
- ✅ **测试**：`tests/steering.test.ts`：广告；空闲交回且不产生模型请求；运行中注入并
  断言 steer 已进入 durable `agent/inbox/spliced`（`target: next-step`）；未知 session 拒绝。

**验收**：回合进行中发 `_session/steering` 得 `injected`；回合刚结束（或空闲）得
`promptRequired`/`noRunningTurn`，客户端按普通 prompt 重投，不会出现 strand-Working。

---

## 3. 缺口 → 机制 映射

| ACP 能力 | 接的机制 | 里程碑 |
|---|---|---|
| `session/load` 回放 | `ctx.sessionPersistence` 读流 + `updates.ts` 投影 | M2 |
| fork / seeded 会话 | `ctx.sessions.create(id, { seed })` + persistence 头字段 | M2（可选） |
| `additionalDirectories` | `ctx.sandbox` / `ctx.permissionPresets` + header 记录 | M3 |
| terminals | —— 评估后放弃：本地执行已足够，ACP 一次性 exec 无法承载持久 PTY（D8/D9） | M4 |
| elicitation | `ctx.userQuestions` provider → ACP `elicitation/create` form | M5 ✅ |
| commands / modes | `ctx.commands` → `available_commands_update`；`plan/mode` + `session/set_mode` | M5 ✅ |
| MCP resources / prompts | 需扩 `packages/mcp/mcp-client`（上游改动） | 上游 |
| SSE / ACP-transport MCP | 同上（当前只有 stdio + streamable-http） | 上游 |
| 图片 prompt | `ctx.attachments` + `resolveModelInfo(...).inputModalities` | M1 |
| 默认模型回落 | `ctx.agentDefaultModel`（Web Models 页的同一服务） | M6（D10） |
| `_session/steering` 中途注入 | `agent.steer()`（next-step 邮箱）+ in-flight prompt 判定 | M7（D11） |

---

## 4. 测试策略

| 层 | 位置 | 要求 | 状态 |
|---|---|---|---|
| 纯函数单测 | `tests/codec.test.ts` 等 | turn ending → stopReason、cursor 编解码、内容/options 投影 | ✅ codec/content/updates/model-control |
| bridge 单测 | `tests/bridge.test.ts` | 官方 SDK + 内存流 + mock `LlmAdapter`，不联网 | ✅ |
| 协议等价 | `tests/parity.test.ts` | 同一输入下本项目与原生 `session/update` 序列相等 | ✅ 6 个场景（握手/文本/max-tokens/工具链/取消/错误） |
| keyless e2e | `tests/e2e/` | 真启动 profile，用官方 SDK 客户端驱动 | 待办（M6 前） |
| 快照 | 录制回放 | 非平凡协议可见变更必须加场景（对应仓库 `docs/testing.md` 的规则） | ✅ M2 回放由 `tests/session-load.test.ts` 的跨 harness 重放锁定；随 M3–M5 扩展 |

运行：`node scripts/run-tests.mjs`（测试由 esbuild 打包后交给 `node --test`；
直接 import `../src/*.ts`，用 tsconfig `paths` 指向 sibling harness checkout）。

---

## 5. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 与原生分叉，语义漂移 | M0/M1 逐段对照；`parity` 测试锁定 `session/update` 序列 |
| 依赖 dsh 未发布版本 | peer 用 `*` + 源码 checkout 开发；发布前收紧并验证 preflight |
| `session/load` 回放与 live 更新交错 | 单一 output tail + 回放期间拒绝新 prompt |
| `additionalDirectories` 放宽沙箱 | 默认关闭；站立 mode 不变；只有经 containment 验证的 `write`/`edit` 单次 escalation 自动放行，bash/越界/read-only 仍交客户端；集合不持久化，load/resume 重校验 |
| terminal 反向信任（客户端执行） | 已评估放弃（D8/D9）：不实现客户端终端，命令一律本地执行 |
| ACP SDK 版本漂移 | 固定 `@agentclientprotocol/sdk` 版本；升级时跑 parity |

**待决策**（实现前记录决定与理由）：

- [ ] D1 `additionalDirectories` 的批准粒度（会话级 vs 目录级）
- [x] D2 elicitation 采用 ACP 标准 `elicitation/create` form 模式（SDK 1.4.0 已提供
  `methods.client.elicitation.create` 与 `clientCapabilities.elicitation.form`），
  不引入自定义扩展方法。见 §2 M5。
- [ ] D3 是否提供 `session/delete`（原生没有；涉及持久化语义）
- [ ] D4 MCP resources 是在本仓库做兼容层，还是推上游改 `mcp-client`
- [x] D5 分发形态：本地 checkout / git（`private: true`，`lib/` 随仓库提交，安装零
  构建），暂不发布 npm；需要 npm 时先选定 scope。见 §2 M6。

已决：

- [x] D6 `session/load` 回放不重放 `usage_update`（当前压力，不是转录事实）；
  loader 在历史之后发布一次最终读数。理由与测试见 §2 M2。
- [x] D1 `additionalDirectories` 采用**会话级、客户端声明**；`enableAdditionalDirectories`
  默认关闭，能力广告要求部署不设限。见 §2 M3。
- [x] D7（修订）harness 沙箱仍是单根，但 M3 改为**复用现有 escalation 权限机制**
  （每次调用一次性放宽 + 路径 containment 校验），不再等待上游。策略内多根
  （`SandboxExecutionPolicy.additionalRoots`）作为可选增强保留。见 §2 M3。
- [x] D8/D9 M4 客户端终端**评估后放弃并删除实现**：ACP 无 stdin、每 create 一条
  命令，无法承载 DSH 持久 PTY 语义；且 DSH 自带本地执行，标准用法（把 bash 路由到
  客户端）需要替换 `ctx.shell`（改核心），单独加工具收益有限。见 §2 M4。
- [x] D10 `provider`/`model` 未配置时回落 `ctx.agentDefaultModel`（Web Models 页的
  同一服务），bundle patch 不再钉死模型路由。理由：DSH patch 对同一行的 `config` 是
  **整体替换**，钉死会迫使用户覆盖时重复 `enable*` 字段并静默丢掉 `session/load`；
  回落让模型配置只需在 composition（或共享的 `$DSH_HOME/cordis.patch.yml`）里配一次。
  见 §2 M6。
- [x] D11 实现 `_session/steering` 扩展（无 deployment gate，客户端只有看到
  `initialize._meta.steering.supported` 才会使用）：运行中走 `agent.steer()`，空闲回
  `{ outcome: 'promptRequired', reason: 'noRunningTurn' }` 交回普通 prompt。见 §2 M7。
