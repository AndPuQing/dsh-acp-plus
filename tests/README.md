# tests/

测试策略见 [PLAN.md §4](../PLAN.md)。测试是 TypeScript（`tests/**/*.ts`），由
`scripts/run-tests.mjs` 用 esbuild 打包到 `.test-build/tests/*.js`，再交给
`node --test` 执行；测试直接 import `../src/*.ts`。

硬要求：

- **keyless**：mock `LlmAdapter` + 临时目录 JSONL 日志，不读 `DEEPSEEK_API_KEY`，可断网跑。
- **行为命名**：测试名描述可观察行为，不描述内部方法。
- **每个 feature 模块一个验收测试**，不允许"以后补"。

| 文件 | 里程碑 | 内容 | 状态 |
|---|---|---|---|
| `codec.test.ts` | M0 | turn ending → `StopReason` 纯函数映射 | ✅ |
| `content.test.ts` | M0–M1 | 富内容准入、图片校验/重读、resource link 文本化 | ✅ |
| `updates.test.ts` | M0 | committed event → `session/update`（reasoning/usage/tool 结果） | ✅ |
| `model-control.test.ts` | M0–M1 | 目录投影、空目录过滤、route 校验、`agent.model` 选择 | ✅ |
| `bridge.test.ts` | M0 | 官方 SDK `ClientSideConnection` + 内存流 + 脚本 adapter：握手、图片能力广告、一轮 prompt、取消、内容拒绝、close、cursor 分页、quiesce | ✅ |
| `session-load.test.ts` | M2 | 跨 harness（模拟进程重启）回放 == 原始序列并可继续 prompt；用户消息 `user_message_chunk` 按序回放且跳过被 replace 遮蔽的节点；occupied id 拒绝；resume 不回放；cwd 不匹配拒绝；未开启时不广告也不服务 | ✅ |
| `settlement.test.ts` | M2（0.2.2） | 取消结算、子代理 drain 顺序、后续 `turn/end` 覆盖 live failure | ✅ |
| `parity.test.ts` | M1 | 同一输入下与原生 `@deepseek-ai/dsh-acp` 的 `session/update` 序列逐条相等（归一化随机 messageId）：握手、文本、max-tokens、工具链、取消、错误 | ✅ |
| `commands.test.ts` | M5 | 命令列表发布/重推；`/name` 拦截执行不产生模型回合；未知斜杠回落模型 | ✅ |
| `modes.test.ts` | M5 | `default`/`plan` 广告、`set_mode` 与 `current_mode_update`、resume 恢复、无 plan-mode 时单模式、沙箱轴不变 | ✅ |
| `elicitation.test.ts` | M5 | 表单构建/答案映射单测；accept/decline/无能力/中止 e2e | ✅ |
| `packaging.test.ts` | M6 | 用 harness 的 `evaluatePluginCompatibility` 锁定 preflight 通过、`dsh-*` peer 已固定；manifest/profile 引用齐全 | ✅ |
| `default-model.test.ts` | M6（D10） | 未配置 provider/model 时回落 `agent-default-model`；图片能力跟随默认路由；显式配置优先 | ✅ |
| `steering.test.ts` | M7（D11） | `_session/steering` 广告、空闲交回、运行中注入（durable inbox 断言）、未知 session 拒绝 | ✅ |
| `directories.test.ts` | M3 | 授权/去重/物理身份/上限与 containment 单测（`processPath` + dev/ino）；能力广告与接受；resume/load 重校验；真实 `write` 工具 e2e：根内 escalation 自动放行并落盘、根外与 read-only 仍向客户端请求 | ✅ |
| `fork.test.ts` | M8 | 完整回合后 fork 出可恢复子会话；live 中途 fork 只继承已完成前缀；无回合/subagent/cwd 不匹配拒绝；历史 `parentSession` 允许；未开启不广告 | ✅ |
| `plan.test.ts` | M9 | `todos` → 整体 `plan` 映射；真实注册表上的 live 与 load 发布；其它 projection 键被过滤；无注册表静默 | ✅ |

`tests/stubs/` 只服务于打包：测试图里的可选/原生依赖（MCP transport、
`node-addon-system/flock`）在这里换成最小替身。`flock` 替身在进程内用
fd 的 dev+inode 模拟内核 advisory lock，这样跨 harness（模拟跨进程）的
write-lease 排斥仍然真实可测。生产 bundle 不受这些替身影响。

`makeBridgeHarness({ sandboxMode })` 可挂 `@deepseek-ai/dsh-sandbox-policy`；
`{ filesystemTools: true }` 再挂真实 `fs-sandbox` + `tool-fs` + `user-approval`，
用于验证 M3 的 escalation 自动预批准（`toolCallResponse()` 脚本一次工具调用）。
`{ bridge: 'native' }` 改挂原生 `@deepseek-ai/dsh-acp`，供 parity 对照。
投影测试使用 testkit 已挂载的真实 `SessionProjectionRegistry`：`plan.test.ts`
注册一个测试专用的 `todos` 单元，由真实的 `session/event` 驱动 `onChanged`，
而不是替换服务（服务名只能注册一次）。

运行：

```sh
pnpm test            # = node scripts/run-tests.mjs
pnpm check           # tsc；只看本项目文件的诊断
```
