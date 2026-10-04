// src/index.ts
import { Buffer as Buffer2 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { realpath as realpath2 } from "node:fs/promises";
import { isAbsolute as isAbsolute3, resolve as resolve2 } from "node:path";
import { Readable, Writable } from "node:stream";
import { brandString } from "@deepseek-ai/dsh-brand";
import { errorChain as errorChain2 } from "@deepseek-ai/dsh-llm";
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError as RequestError2
} from "@agentclientprotocol/sdk";

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  provider: Schema.string().description("Provider route for agents created by this bridge, e.g. deepseek-official."),
  model: Schema.string().description("Exact model id for agents created by this bridge, e.g. deepseek-v4-flash."),
  sessionListPageSize: Schema.natural().min(1).default(100).description("Maximum sessions returned by one session/list page."),
  enableSessionLoad: Schema.boolean().default(false).description("Advertise and serve session/load: replay the persisted transcript after reopening."),
  enableAdditionalDirectories: Schema.boolean().default(false).description("Accept additionalDirectories; verified single-target writes under a declared root are pre-approved.")
});
function resolveSpec(config) {
  const selection = config.provider === void 0 || config.model === void 0 ? void 0 : { provider: config.provider, model: config.model };
  return {
    provider: config.provider,
    model: config.model,
    selection,
    sessionListPageSize: config.sessionListPageSize ?? 100,
    stream: config.stream,
    features: {
      sessionLoad: config.enableSessionLoad ?? false,
      additionalDirectories: config.enableAdditionalDirectories ?? false
    }
  };
}

// src/content.ts
import { Buffer } from "node:buffer";
import { isImageAdmissionError } from "@deepseek-ai/dsh-attachment";
var IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
];
var CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
var AcpPlusContentError = class extends Error {
  /** Whether the bridge should report invalid params or an internal failure. */
  kind;
  /**
   * @param message - safe protocol-facing detail without inline binary data.
   * @param kind - request-failure category.
   * @param options - optional causal chain for diagnostics.
   */
  constructor(message, kind, options) {
    super(message, options);
    this.name = "AcpPlusContentError";
    this.kind = kind;
  }
};
function imageMediaType(value) {
  return IMAGE_MEDIA_TYPES.includes(value) ? value : void 0;
}
function decodeImage(block) {
  const mediaType = imageMediaType(block.mimeType);
  if (mediaType === void 0) {
    throw new AcpPlusContentError("image mimeType must be image/png, image/jpeg, image/webp, or image/gif", "invalid");
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new AcpPlusContentError("image data must be canonical base64", "invalid");
  }
  const data = Buffer.from(block.data, "base64");
  if (data.toString("base64") !== block.data) {
    throw new AcpPlusContentError("image data must be canonical base64", "invalid");
  }
  return { data, mediaType };
}
async function assertImageRoute(ctx, route, signal) {
  const provider = route?.provider;
  const model = route?.model;
  const llm = ctx.get("llm");
  if (provider === void 0 || model === void 0 || llm === void 0) {
    throw new AcpPlusContentError("the current model route could not be resolved for image input", "invalid");
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, signal);
  } catch (error) {
    throw new AcpPlusContentError("the current model route could not be verified for image input", "internal", { cause: error });
  }
  if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) {
    throw new AcpPlusContentError(`model "${model}" does not declare image input`, "invalid");
  }
}
async function supportsAcpImagePrompts(ctx, provider, model) {
  const attachments = ctx.get("attachments");
  const llm = ctx.get("llm");
  if (attachments === void 0 || llm === void 0 || provider === void 0 || model === void 0) return false;
  if (!attachments.imageLimits.mediaTypes.some((mediaType) => IMAGE_MEDIA_TYPES.includes(mediaType))) return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info.inputModalities?.includes("image") === true;
  } catch {
    return false;
  }
}
function resourceLinkText(block) {
  return `
[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]
`;
}
async function admitAcpPrompt(ctx, route, prompt, imageEnabled, signal) {
  const images = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
      case "resource_link":
        break;
      case "image":
        if (!imageEnabled) throw new AcpPlusContentError("inline image prompts were not advertised by this connection", "invalid");
        images.push(decodeImage(block));
        break;
      case "audio":
        throw new AcpPlusContentError("audio prompt content is not supported", "invalid");
      case "resource":
        throw new AcpPlusContentError("embedded resource prompt content is not supported", "invalid");
      default:
        throw new AcpPlusContentError("unsupported ACP prompt content", "invalid");
    }
  }
  let refs = [];
  if (images.length > 0) {
    const attachments = ctx.get("attachments");
    if (attachments === void 0) throw new AcpPlusContentError("no attachment store is mounted", "invalid");
    await assertImageRoute(ctx, route, signal);
    signal.throwIfAborted();
    try {
      refs = await attachments.saveImages(images);
    } catch (error) {
      if (isImageAdmissionError(error)) {
        throw new AcpPlusContentError(error.message, "invalid", { cause: error });
      }
      throw new AcpPlusContentError("unable to persist the prompt image batch", "internal", { cause: error });
    }
    signal.throwIfAborted();
  }
  const content = [];
  let pendingText = "";
  let imageIndex = 0;
  const flushText = () => {
    if (pendingText.length === 0) return;
    content.push({ type: "text", text: pendingText });
    pendingText = "";
  };
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        pendingText += block.text;
        break;
      case "resource_link":
        pendingText += resourceLinkText(block);
        break;
      case "image": {
        flushText();
        const ref = refs[imageIndex++];
        content.push({ type: "image", attachment: ref });
        break;
      }
      // The validation pass above rejects both tags before reconstruction.
      case "audio":
      case "resource":
        break;
      default:
        break;
    }
  }
  flushText();
  if (!content.some((block) => block.type === "image" || block.type === "text" && block.text.trim().length > 0)) {
    throw new AcpPlusContentError("empty prompt", "invalid");
  }
  return content;
}
async function assistantBlockToAcp(ctx, block) {
  if (block.type === "text") {
    return block.text.length === 0 ? void 0 : { type: "text", text: block.text };
  }
  if (block.type !== "image") return void 0;
  const attachments = ctx.get("attachments");
  if (attachments === void 0) {
    throw new AcpPlusContentError("cannot deliver assistant image: no attachment store is mounted", "internal");
  }
  let stored;
  try {
    stored = await attachments.readImage(block.attachment);
  } catch (error) {
    throw new AcpPlusContentError("cannot deliver assistant image: the attachment is unavailable or corrupt", "internal", { cause: error });
  }
  return {
    type: "image",
    data: Buffer.from(stored.data).toString("base64"),
    mimeType: stored.ref.mediaType
  };
}

// src/features/additional-directories.ts
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
var MAX_ADDITIONAL_DIRECTORIES = 16;
var SINGLE_TARGET_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
var ADDITIONAL_DIRECTORIES_CONTEXT = "acp-plus:additional-directories";
var AcpPlusAdditionalDirectoriesError = class extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message) {
    super(message);
    this.name = "AcpPlusAdditionalDirectoriesError";
  }
};
async function canonicalDirectory(path) {
  try {
    const [canonical, info] = await Promise.all([realpath(path), stat(path)]);
    return info.isDirectory() ? canonical : void 0;
  } catch (_unresolvablePath) {
    return void 0;
  }
}
function isPathUnder(path, root) {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return process.platform === "win32" ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
}
async function authorizeAdditionalDirectories(cwd, directories) {
  if (directories.length === 0) return [];
  if (directories.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new AcpPlusAdditionalDirectoriesError(
      `additionalDirectories accepts at most ${MAX_ADDITIONAL_DIRECTORIES} entries`
    );
  }
  const canonicalCwd = await canonicalDirectory(cwd) ?? resolve(cwd);
  const roots = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of directories) {
    if (!isAbsolute(entry)) {
      throw new AcpPlusAdditionalDirectoriesError(`additionalDirectories entries must be absolute paths: ${entry}`);
    }
    const canonical = await canonicalDirectory(entry);
    if (canonical === void 0) {
      throw new AcpPlusAdditionalDirectoriesError(`additionalDirectories entry is not an existing directory: ${entry}`);
    }
    if (canonical === canonicalCwd || seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push(canonical);
  }
  return roots;
}
async function preApprovedEscalation(ctx, session, roots, toolName, filePath) {
  if (roots.length === 0 || filePath === void 0 || !SINGLE_TARGET_TOOLS.has(toolName)) return false;
  const policy = ctx.get("sandboxPolicy");
  if (policy !== void 0 && policy.resolve({ session }).mode !== "workspace-write") return false;
  const fs = ctx.get("fs");
  if (fs === void 0) return false;
  let target;
  try {
    target = await fs.resolve(filePath, {
      ...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
    });
  } catch (_unresolvableTarget) {
    return false;
  }
  return roots.some((root) => isPathUnder(String(target.targetKey), root));
}
function registerAdditionalDirectoriesContext(agentCtx, roots) {
  if (roots.length === 0) return;
  const systemPrompt = agentCtx.get("systemPrompt");
  if (systemPrompt === void 0) return;
  systemPrompt.context({
    name: ADDITIONAL_DIRECTORIES_CONTEXT,
    order: systemPrompt.getContextOrder("SANDBOX_POLICY") + 1,
    text: () => `Additional workspace roots pre-authorized by the client: ${roots.map((root) => JSON.stringify(root)).join(", ")}. A write or edit whose path lies inside one of these roots is pre-approved: include sandbox_permissions="danger-full-access" and a one-sentence justification on that call. Anything outside them keeps the standing sandbox policy and its approval flow.`
  });
}

// src/features/elicitation.ts
var OTHER_SUFFIX = "__other";
function choiceField(question) {
  const options = question.options ?? [];
  const title = question.header ?? question.question;
  const description = question.header === void 0 ? question.detail : question.question;
  const base = {
    title,
    ...description === void 0 ? {} : { description }
  };
  return question.multiSelect === true ? {
    type: "array",
    ...base,
    items: { type: "string", enum: options.map((option) => option.label) }
  } : {
    type: "string",
    ...base,
    oneOf: options.map((option) => ({
      const: option.label,
      title: option.label,
      ...option.description === void 0 ? {} : { description: option.description }
    }))
  };
}
function buildFormRequest(sessionId, request) {
  const properties = {};
  for (const question of request.questions) {
    const options = question.options ?? [];
    if (options.length === 0) {
      properties[question.id] = {
        type: "string",
        title: question.header ?? question.question,
        ...question.detail === void 0 ? {} : { description: question.detail }
      };
      continue;
    }
    properties[question.id] = choiceField(question);
    properties[`${question.id}${OTHER_SUFFIX}`] = {
      type: "string",
      title: "Other (optional)",
      description: "Free-text answer instead of the listed choices."
    };
  }
  return {
    sessionId,
    mode: "form",
    message: request.questions.map((question) => question.question).join("\n\n"),
    requestedSchema: { type: "object", properties }
  };
}
function answerItem(question, content) {
  const value = content[question.id];
  const selected = question.multiSelect === true ? Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [] : typeof value === "string" && value.length > 0 ? [value] : [];
  const other = content[`${question.id}${OTHER_SUFFIX}`];
  const custom = typeof other === "string" ? other.trim() : "";
  return {
    id: question.id,
    selected,
    ...custom.length === 0 ? {} : { custom }
  };
}
function mapFormAnswer(request, response) {
  if (response.action !== "accept") {
    throw new Error(response.action === "decline" ? "The user declined to answer the question." : "The user cancelled the question.");
  }
  const content = response.content ?? {};
  return { answers: request.questions.map((question) => answerItem(question, content)) };
}
async function raceAbort(promise, signal) {
  if (signal === void 0) return promise;
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const onAbort = () => {
    aborted.reject(signal.reason ?? new Error("the question was withdrawn"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function answerWithElicitation(host, sessionId, request) {
  const response = await raceAbort(host.create(buildFormRequest(sessionId, request), request.signal), request.signal);
  return mapFormAnswer(request, response);
}

// src/features/modes.ts
var DEFAULT_MODE_ID = "default";
var PLAN_MODE_ID = "plan";
var DEFAULT_MODE = {
  id: DEFAULT_MODE_ID,
  name: "Default",
  description: "Carry out the task directly."
};
var PLAN_MODE = {
  id: PLAN_MODE_ID,
  name: "Plan",
  description: "Research and present a plan before making changes."
};
var AcpPlusSessionModeError = class extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message) {
    super(message);
    this.name = "AcpPlusSessionModeError";
  }
};
function availableSessionModes(ctx) {
  return ctx.get("planMode") === void 0 ? [DEFAULT_MODE] : [DEFAULT_MODE, PLAN_MODE];
}
function planModeActive(ctx, session) {
  return ctx.get("sessionProjections")?.stateOf(session, "plan")?.active === true;
}
function sessionModeState(ctx, session) {
  if (ctx.get("planMode") === void 0) return void 0;
  return {
    currentModeId: planModeActive(ctx, session) ? PLAN_MODE_ID : DEFAULT_MODE_ID,
    availableModes: [...availableSessionModes(ctx)]
  };
}
function setSessionMode(ctx, agent, modeId) {
  const planMode = ctx.get("planMode");
  if (modeId === DEFAULT_MODE_ID) {
    planMode?.set(agent, false);
    return;
  }
  if (modeId === PLAN_MODE_ID && planMode !== void 0) {
    planMode.set(agent, true);
    return;
  }
  throw new AcpPlusSessionModeError(`unknown session mode: ${modeId}`);
}

// src/updates.ts
async function assistantUpdates(ctx, session, event) {
  const updates = [];
  for (const block of event.data.message.content) {
    if (block.type === "reasoning") {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          messageId: event.data.message.id,
          content: { type: "text", text: block.text }
        });
      }
      continue;
    }
    const content = await assistantBlockToAcp(ctx, block);
    if (content !== void 0) {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        messageId: event.data.message.id,
        content
      });
    }
  }
  const usage = event.data.usage === void 0 ? void 0 : usageUpdate(ctx, session);
  if (usage !== void 0) updates.push(usage);
  return updates;
}
function toolCallUpdate(event) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: "other",
    status: "in_progress",
    rawInput: parseToolArguments(event.data.arguments)
  };
}
async function toolResultUpdate(ctx, event) {
  const message = event.data.message;
  const content = [];
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block);
    if (converted !== void 0) content.push({ type: "content", content: converted });
  }
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: message.toolCallId,
    status: message.isError === true ? "failed" : "completed",
    content
  };
}
function usageUpdate(ctx, session) {
  const size = session.requestContext()?.contextWindow;
  const meter = ctx.get("tokenMeter");
  if (size === void 0 || meter === void 0) return void 0;
  return {
    sessionUpdate: "usage_update",
    used: meter.measure(session).totalTokens,
    size
  };
}
function parseToolArguments(value) {
  try {
    return JSON.parse(value);
  } catch (_invalidModelJson) {
    return value;
  }
}

// src/features/session-load.ts
var REPLAY_SESSION = { requestContext: () => void 0 };
async function replaySession(ctx, sessionId, notify, signal) {
  const options = signal === void 0 ? void 0 : { signal };
  const handle = await ctx.sessionPersistence.open(sessionId, "read", options);
  let events;
  try {
    events = (await handle.read(0, void 0, options)).events;
  } catch (error) {
    try {
      await handle.close();
    } catch {
    }
    throw error;
  }
  await handle.close();
  for (const event of events) {
    signal?.throwIfAborted();
    if (event.type === "assistant/message") {
      for (const update of await assistantUpdates(ctx, REPLAY_SESSION, event)) {
        await notify({ sessionId, update });
      }
    } else if (event.type === "tool/call") {
      await notify({ sessionId, update: toolCallUpdate(event) });
    } else if (event.type === "tool/result") {
      await notify({ sessionId, update: await toolResultUpdate(ctx, event) });
    }
  }
}

// src/features/steering.ts
var STEERING_METHOD = "_session/steering";
function steeringInitializeMeta() {
  return { steering: { supported: true } };
}
function parseSteeringRequest(params) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("_session/steering params must be an object");
  }
  return params;
}
function steeringText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) return void 0;
  const texts = [];
  for (const block of prompt) {
    if (typeof block !== "object" || block === null) return void 0;
    const { type, text: text2 } = block;
    if (type !== "text" || typeof text2 !== "string") return void 0;
    texts.push(text2);
  }
  const text = texts.join("");
  return text.trim() === "" ? void 0 : text;
}

// src/mcp.ts
import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isAbsolute as isAbsolute2 } from "node:path";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
var VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
var AcpPlusMcpConfigError = class extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message) {
    super(message);
    this.name = "AcpPlusMcpConfigError";
  }
};
async function mountAcpMcpServers(agentCtx, servers, sessionCwd) {
  const configs = resolveMcpConfigs(servers, sessionCwd);
  for (const config of configs) await agentCtx.plugin(McpClient, config);
}
function resolveMcpConfigs(servers, sessionCwd) {
  const names = /* @__PURE__ */ new Set();
  return servers.map((server, index) => {
    const serverName = normalizeServerName(server.name);
    if (names.has(serverName)) {
      throw new AcpPlusMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`);
    }
    names.add(serverName);
    if (!("type" in server)) {
      if (!isAbsolute2(server.command)) {
        throw new AcpPlusMcpConfigError(`mcpServers[${index}].command must be an absolute path`);
      }
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, "environment");
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: "stdio",
        serverName,
        command: server.command,
        args: server.args,
        env,
        cwd: sessionCwd,
        failOnStartupError: true
      }));
      return { ...config, env };
    }
    if (server.type === "http") {
      assertHttpUrl(server.url, `mcpServers[${index}].url`);
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, "header");
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: "streamable-http",
        serverName,
        url: server.url,
        headers,
        failOnStartupError: true
      }));
      return { ...config, headers };
    }
    throw new AcpPlusMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`);
  });
}
function entriesToRecord(entries, field, kind) {
  const result = /* @__PURE__ */ Object.create(null);
  const names = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (kind === "header") {
      try {
        validateHeaderName(entry.name);
        validateHeaderValue(entry.name, entry.value);
      } catch (_invalidHeader) {
        throw new AcpPlusMcpConfigError(`${field} contains an invalid header entry`);
      }
    } else if (entry.name.length === 0 || entry.name.includes("=") || entry.name.includes("\0") || entry.value.includes("\0")) {
      throw new AcpPlusMcpConfigError(`${field} contains an invalid environment entry`);
    }
    const identity = kind === "header" ? entry.name.toLowerCase() : entry.name;
    if (names.has(identity)) throw new AcpPlusMcpConfigError(`${field} contains duplicate name: ${entry.name}`);
    names.add(identity);
    result[entry.name] = entry.value;
  }
  return result;
}
function normalizeServerName(name2) {
  if (name2.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name2)) {
    throw new AcpPlusMcpConfigError("mcpServers contains an invalid server name");
  }
  if (VALID_SERVER_NAME.test(name2)) return name2;
  const slug = name2.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "server";
  const digest = createHash("sha256").update(name2).digest("hex").slice(0, 8);
  return `${slug}_${digest}`.slice(0, 32);
}
function assertHttpUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch (_invalidUrl) {
    throw new AcpPlusMcpConfigError(`${field} must be an absolute HTTP(S) URL`);
  }
}
function validateClientConfig(index, parse) {
  try {
    return parse();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AcpPlusMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`);
  }
}

// src/model-control.ts
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
var MODEL_CONFIG_ID = "model";
var REASONING_CONFIG_ID = "reasoning_effort";
var PROVIDER_DEFAULT_REASONING_VALUE = "";
var AcpPlusModelConfigError = class extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message) {
    super(message);
    this.name = "AcpPlusModelConfigError";
  }
};
var AcpPlusModelControl = class {
  /**
   * @param llm - live LLM runtime supplying the provider/model catalog.
   * @param initial - deployment selection, or undefined when a listener supplies it.
   */
  constructor(llm, initial) {
    this.llm = llm;
    this.selected = initial;
    const getCurrent = () => this.turnSelection?.selection ?? this.selected;
    const setCurrent = (value) => {
      this.selected = value;
    };
    this.selection = {
      get current() {
        return getCurrent();
      },
      set current(value) {
        setCurrent(value);
      },
      assembled: void 0
    };
  }
  /** Scoped selection reference consumed by Agent request assembly. */
  selection;
  tail = Promise.resolve();
  selected;
  turnSelection;
  hasResolvedState = false;
  /**
   * Install request/prompt consistency listeners in the unpublished Agent scope.
   * @param agentCtx - Agent scope that consumes this selection.
   */
  install(agentCtx) {
    installModelSelection(agentCtx, this.selection);
  }
  /**
   * Snapshot the selection attached to the next accepted ACP prompt.
   * @returns a detached future selection, or undefined when listeners supply the route.
   */
  snapshot() {
    return this.selected === void 0 ? void 0 : { ...this.selected };
  }
  /**
   * Pin one admitted ACP message's selection for every step in its turn.
   * @param turn - admitted Agent turn.
   * @param selection - exact prompt-admission selection.
   */
  pinTurn(turn, selection) {
    this.turnSelection = { turn, selection: { ...selection } };
  }
  /**
   * Release only the exact completed turn's routing override.
   * @param turn - completed Agent turn.
   */
  releaseTurn(turn) {
    if (this.turnSelection?.turn === turn) this.turnSelection = void 0;
  }
  /**
   * Return the complete standard config-option state after prior mutations settle.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  options(signal) {
    return this.serialize(async () => (await this.state(signal)).options);
  }
  /**
   * Set one advertised option and return the complete resulting option state.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  set(configId, value, signal) {
    return this.serialize(async () => {
      if (typeof value !== "string") throw new AcpPlusModelConfigError(`${configId} requires a select value`);
      const current = this.selected;
      if (current === void 0) throw new AcpPlusModelConfigError("this session has no model selection");
      if (configId === MODEL_CONFIG_ID) {
        const state = await this.state(signal);
        const selected = state.choices.get(value);
        if (selected === void 0) throw new AcpPlusModelConfigError(`unknown model option: ${value}`);
        await this.resolveSelection(selected, signal);
        this.selected = selected;
      } else if (configId === REASONING_CONFIG_ID) {
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal);
        const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE && info.reasoning?.defaultEffort === void 0;
        if (info.reasoning === void 0 || !providerDefault && !info.reasoning.efforts.some((effort) => effort.id === value)) {
          throw new AcpPlusModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`);
        }
        this.selected = await this.resolveSelection({
          provider: current.provider,
          model: current.model,
          ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) }
        }, signal);
      } else {
        throw new AcpPlusModelConfigError(`unknown session config option: ${configId}`);
      }
      return (await this.state(signal)).options;
    });
  }
  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  serialize(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => void 0, () => void 0);
    return result;
  }
  /** Build detached model choices and the dependent reasoning option. */
  async state(signal) {
    const selected = this.selected;
    if (selected === void 0) return { choices: /* @__PURE__ */ new Map(), options: [] };
    let resolved;
    let routeAvailable = true;
    try {
      resolved = await this.resolveSelection(selected, signal);
      this.hasResolvedState = true;
    } catch (error) {
      if (!this.hasResolvedState) throw error;
      resolved = selected;
      routeAvailable = false;
    }
    const choices = /* @__PURE__ */ new Map();
    const groups = await Promise.all(this.llm.listProviders().map(async (provider) => {
      try {
        const models = await this.llm.listModels(provider.id);
        const entries = models.map((model) => {
          const choice = {
            value: modelValue(provider.id, model.id),
            selection: { provider: provider.id, model: model.id }
          };
          choices.set(choice.value, choice.selection);
          return {
            value: choice.value,
            name: model.name,
            ...model.description === void 0 ? {} : { description: model.description }
          };
        });
        return { group: provider.id, name: provider.name, options: entries };
      } catch (_providerCatalogUnavailable) {
        return { group: provider.id, name: provider.name, options: [] };
      }
    }));
    const currentValue = modelValue(resolved.provider, resolved.model);
    if (!choices.has(currentValue)) {
      choices.set(currentValue, { provider: resolved.provider, model: resolved.model });
      let group = groups.find((item) => item.group === resolved.provider);
      if (group === void 0) {
        group = { group: resolved.provider, name: resolved.provider, options: [] };
        groups.push(group);
      }
      group.options.unshift({ value: currentValue, name: resolved.model });
    }
    const options = [{
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: groups.filter((group) => group.options.length > 0)
    }];
    const info = routeAvailable ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal) : void 0;
    if (info?.reasoning !== void 0) {
      options.push({
        id: REASONING_CONFIG_ID,
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: resolved.reasoningEffort === void 0 ? PROVIDER_DEFAULT_REASONING_VALUE : String(resolved.reasoningEffort),
        options: [
          ...info.reasoning.defaultEffort === void 0 ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: "Provider default" }] : [],
          ...info.reasoning.efforts.map((effort) => ({
            value: String(effort.id),
            name: effort.name,
            ...effort.description === void 0 ? {} : { description: effort.description }
          }))
        ]
      });
    }
    return { choices, options };
  }
  /** Validate an exact route and retain only Agent-owned selection fields. */
  async resolveSelection(selection, signal) {
    const resolved = await this.llm.resolveCallConfig(selection, signal);
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }
    };
  }
};
function modelValue(provider, model) {
  return JSON.stringify([provider, model]);
}

// src/sessions.ts
import {
  RequestError
} from "@agentclientprotocol/sdk";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";

// src/codec.ts
function turnEndToStopReason(reason) {
  switch (reason.kind) {
    case "completed":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case "aborted":
      return "end_turn";
    case "interrupted":
      return "cancelled";
    case "blocked":
    case "error":
      return "end_turn";
    // TurnEndReason is merge-extensible; seed-only variants (`forked`) never
    // end an ACP prompt turn, so every remaining member is ordinary quiescence.
    default:
      return "end_turn";
  }
}

// src/features/commands.ts
var parseCommand;
function availableCommands(ctx, agent) {
  const commands = ctx.get("commands");
  if (commands === void 0) return [];
  return commands.list(agent).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === void 0 ? {} : { input: { hint: descriptor.input.hint } }
  }));
}
function promptCommandLine(prompt) {
  if (prompt.length === 0) return void 0;
  let text = "";
  for (const block of prompt) {
    if (block.type !== "text") return void 0;
    text += block.text;
  }
  const line = text.trimStart();
  return line.startsWith("/") ? line : void 0;
}
async function parseSlashCommand(line) {
  if (parseCommand === void 0) {
    parseCommand = (await import("@deepseek-ai/dsh-commands")).parseCommand;
  }
  const parsed = parseCommand(line);
  return parsed === void 0 ? void 0 : { name: parsed.name, line };
}
function commandRunUpdate(event) {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: `/${event.data.name}${event.data.args ?? ""}` }
  };
}
function commandDoneUpdate(event) {
  const text = event.data.text;
  if (text === void 0 || text.length === 0) return void 0;
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

// src/sessions.ts
function invalidParams(detail) {
  return RequestError.invalidParams(void 0, detail);
}
function internalError(detail) {
  return RequestError.internalError(void 0, detail);
}
function selectionFor(logged, fallback) {
  return logged === void 0 ? fallback : {
    provider: logged.config.provider,
    model: logged.config.model,
    ...logged.config.reasoningEffort === void 0 || logged.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: logged.config.reasoningEffort }
  };
}
function parseToolArguments2(value) {
  try {
    return JSON.parse(value);
  } catch (_invalidModelJson) {
    return void 0;
  }
}
var AcpPlusSession = class _AcpPlusSession {
  constructor(ctx, handle, modelControl, additionalDirectories, notify) {
    this.ctx = ctx;
    this.notify = notify;
    this.agent = handle.agent;
    this.modelControl = modelControl;
    this.additionalDirectories = additionalDirectories;
    this.disposeAgent = () => handle.dispose();
  }
  /** The exact top-level Agent owned by this ACP session. */
  agent;
  modelControl;
  outputTail = Promise.resolve();
  inflight;
  closing;
  /** Current slash-command execution, aborted by session cancellation or close. */
  commandAbort;
  pendingSelections = /* @__PURE__ */ new Map();
  /** Model-supplied arguments of in-flight tool calls, for escalation checks. */
  toolCalls = /* @__PURE__ */ new Map();
  /** Client-declared additional workspace roots, canonical and deduplicated. */
  additionalDirectories;
  disposeAgent;
  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - plugin context carrying the agent factory, LLM, and persistence.
   * @param options - fresh identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx, options) {
    const modelControl = new AcpPlusModelControl(ctx.llm, options.fallbackSelection);
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx);
        registerAdditionalDirectoriesContext(agentCtx, options.additionalDirectories);
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
      }
    });
    return new _AcpPlusSession(ctx, handle, modelControl, options.additionalDirectories, options.notify);
  }
  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * @param ctx - plugin context carrying the agent factory, LLM, and persistence.
   * @param options - persisted identity, workspace, fallback route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx, options) {
    let modelControl;
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpPlusModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection)
        );
        modelControl.install(agentCtx);
        registerAdditionalDirectoriesContext(agentCtx, options.additionalDirectories);
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
      }
    });
    if (modelControl === void 0) {
      await handle.dispose();
      throw internalError("session/resume did not compose model selection");
    }
    return new _AcpPlusSession(ctx, handle, modelControl, options.additionalDirectories, options.notify);
  }
  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent) {
    return this.agent === agent;
  }
  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session) {
    return this.agent.session === session;
  }
  /**
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns every advertised configuration option.
   */
  configOptions(signal) {
    this.assertActive();
    return this.modelControl.options(signal);
  }
  /**
   * Apply one standard configuration option to later ACP turns.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  setConfig(configId, value, signal) {
    this.assertActive();
    return this.modelControl.set(configId, value, signal);
  }
  /** Publish the current command list to this session's client. */
  publishCommands() {
    if (this.ctx.get("commands") === void 0) return;
    const availableCommandsForAgent = availableCommands(this.ctx, this.agent);
    this.enqueue(() => this.notify({
      sessionId: this.agent.session.id,
      update: { sessionUpdate: "available_commands_update", availableCommands: availableCommandsForAgent }
    }));
  }
  /**
   * Read the complete ACP mode state for this session.
   * @returns current mode id plus every mode this deployment offers, or undefined.
   */
  modeState() {
    return sessionModeState(this.ctx, this.agent.session);
  }
  /**
   * Apply one requested ACP mode to this session's agent.
   * @param modeId - requested ACP mode id.
   */
  setMode(modeId) {
    this.assertActive();
    setSessionMode(this.ctx, this.agent, modeId);
  }
  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged() {
    if (this.closing !== void 0) return;
    void this.modelControl.options().then((configOptions) => {
      if (this.closing !== void 0) return;
      this.enqueue(() => this.notify({
        sessionId: this.agent.session.id,
        update: { sessionUpdate: "config_option_update", configOptions }
      }));
    }).catch((error) => {
      this.ctx.logger.warn(`acp-plus: config-option update failed: ${errorChain(error)}`);
    });
  }
  /**
   * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(params, imageEnabled, requestSignal) {
    this.assertActive();
    const commandLine = promptCommandLine(params.prompt);
    if (commandLine !== void 0) {
      const command = await parseSlashCommand(commandLine);
      if (command !== void 0 && this.ctx.get("commands")?.find(this.agent, command.name) !== void 0) {
        return this.executeCommand(command.line, requestSignal);
      }
    }
    if (this.inflight !== void 0) throw invalidParams("a prompt is already in flight for this session");
    const completion = Promise.withResolvers();
    const admission = Promise.withResolvers();
    const admissionController = new AbortController();
    const inflight = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: void 0,
      messageQueued: false,
      turn: void 0,
      endReason: void 0,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: void 0,
      agentError: void 0
    };
    this.inflight = inflight;
    const onRequestAbort = () => {
      this.cancelPrompt("ACP prompt request cancelled");
    };
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
    if (requestSignal?.aborted === true) onRequestAbort();
    try {
      let admissionFailure;
      const promptSelection = this.modelControl.snapshot();
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError("prompt was not queued: the agent was disposed outside the bridge");
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal
        );
        admissionController.signal.throwIfAborted();
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError("prompt was not queued: the agent was disposed outside the bridge");
        }
        const message = createUserMessage({
          content,
          source: { kind: "user" }
        });
        inflight.messageId = message.id;
        inflight.messageQueued = true;
        if (promptSelection !== void 0) this.pendingSelections.set(message.id, promptSelection);
        try {
          this.agent.followup(message);
        } catch (error) {
          inflight.messageQueued = false;
          this.pendingSelections.delete(message.id);
          throw error;
        }
      } catch (error) {
        admissionFailure = error;
      } finally {
        inflight.finishAdmission();
      }
      if (inflight.cancelRequested) {
        this.settleAfterQuiescence(inflight);
        return { stopReason: await completion.promise };
      }
      if (admissionFailure !== void 0) {
        this.inflight = void 0;
        if (admissionFailure instanceof AcpPlusContentError) {
          throw admissionFailure.kind === "invalid" ? invalidParams(admissionFailure.message) : internalError(admissionFailure.message);
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure;
        throw internalError(`prompt was not queued: ${admissionFailure.message}`);
      }
      this.settleAfterQuiescence(inflight);
      return { stopReason: await completion.promise };
    } finally {
      requestSignal?.removeEventListener("abort", onRequestAbort);
    }
  }
  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel() {
    const inflight = this.inflight;
    this.cancelPrompt("ACP prompt cancelled");
    if (inflight === void 0) this.agent.cancel({ kind: "user" });
    this.commandAbort?.abort(new Error("ACP session cancelled"));
  }
  /**
   * Inject one client steer into the live turn at its next step boundary.
   * @param text - steering text already validated by the feature module.
   * @returns true when a live ACP prompt consumed it; false when the session
   *   is idle, cancelling, or otherwise not running, so the caller answers
   *   `promptRequired` instead of waking an untracked turn.
   */
  steer(text) {
    const inflight = this.inflight;
    if (inflight === void 0 || inflight.cancelRequested || this.agent.status !== "running") return false;
    this.agent.steer(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" }
    }));
    return true;
  }
  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  onSessionEvent(session, event) {
    if (event.type === "tool/call") {
      this.toolCalls.set(String(event.data.callId), {
        name: event.data.name,
        arguments: parseToolArguments2(event.data.arguments)
      });
    } else if (event.type === "tool/result") {
      this.toolCalls.delete(String(event.data.message.toolCallId));
    }
    try {
      if (event.type === "assistant/message") {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : void 0;
        const previous = this.outputTail;
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update });
          }
        });
        this.outputTail = delivery.catch((error) => {
          const failure = error;
          if (inflight !== void 0) inflight.outputError ??= failure;
          this.ctx.logger.warn(`acp-plus: assistant output conversion failed: ${errorChain(error)}`);
        });
      } else if (event.type === "tool/call") {
        this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }));
      } else if (event.type === "tool/result") {
        this.enqueue(async () => this.notify({
          sessionId: this.agent.session.id,
          update: await toolResultUpdate(this.ctx, event)
        }));
      } else if (event.type === "command/run") {
        this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update: commandRunUpdate(event) }));
      } else if (event.type === "command/done") {
        const update = commandDoneUpdate(event);
        if (update !== void 0) {
          this.enqueue(() => this.notify({ sessionId: this.agent.session.id, update }));
        }
      } else if (event.type === "plan/mode") {
        this.enqueue(() => this.notify({
          sessionId: this.agent.session.id,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: event.data.active ? PLAN_MODE_ID : DEFAULT_MODE_ID
          }
        }));
      }
    } finally {
      const inflight = this.inflight;
      if (inflight !== void 0 && event.type === "turn/end" && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason;
      }
      if (event.type === "turn/end") this.modelControl.releaseTurn(event.data.turn);
    }
  }
  /**
   * Correlate an accepted user message with its Agent turn and pinned route.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message, turn) {
    if (this.inflight !== void 0 && this.inflight.messageId === message.id) this.inflight.turn = turn;
    const selection = this.pendingSelections.get(message.id);
    this.pendingSelections.delete(message.id);
    if (selection !== void 0) this.modelControl.pinTurn(turn, selection);
  }
  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param turn - failed turn number.
   * @param error - original same-process failure.
   */
  onAgentError(turn, error) {
    const inflight = this.inflight;
    if (inflight === void 0 || !inflight.messageQueued) return;
    if (inflight.turn === turn) return;
    inflight.agentError = new Error(errorChain(error));
    this.settleAfterQuiescence(inflight);
  }
  /** Await every update queued before this call. */
  drainUpdates() {
    return this.outputTail;
  }
  /**
   * Whether one tool escalation is already covered by the session's declared
   * roots. Only externally verifiable single-target writes qualify; every other
   * ask must reach the client.
   * @param toolName - tool the approval request names.
   * @param callId - exact call the approval attaches to.
   * @returns true when the recorded call's target lies inside a declared root.
   */
  isPreApprovedEscalation(toolName, callId) {
    const call = this.toolCalls.get(callId);
    if (call === void 0 || call.name !== toolName) return Promise.resolve(false);
    const filePath = call.arguments?.file_path;
    return preApprovedEscalation(
      this.ctx,
      this.agent.session,
      this.additionalDirectories,
      toolName,
      typeof filePath === "string" ? filePath : void 0
    );
  }
  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail) {
    if (this.closing !== void 0) return this.closing;
    this.closing = (async () => {
      const failures = [];
      const inflight = this.inflight;
      this.commandAbort?.abort(new Error(detail));
      this.cancelPrompt(detail);
      if (inflight === void 0 || !inflight.messageQueued) this.agent.cancel({ kind: "user" });
      try {
        await inflight?.admissionDone;
        await this.agent.whenIdle();
        await this.outputTail;
      } catch (error) {
        failures.push(new Error("ACP session activity drain failed", { cause: error }));
      }
      const subagents = this.ctx.get("subagents");
      try {
        await subagents?.drainContinuableDescendants([this.agent]);
      } catch (error) {
        this.ctx.logger.warn(`acp-plus: continuable subagent teardown failed: ${errorChain(error)}`);
        failures.push(new Error("continuable subagent teardown failed", { cause: error }));
      }
      try {
        await this.ctx.sessions.flush(this.agent.session);
      } catch (error) {
        failures.push(new Error("ACP session persistence flush failed", { cause: error }));
      }
      try {
        await this.disposeAgent();
      } catch (error) {
        failures.push(error);
      }
      this.pendingSelections.clear();
      this.toolCalls.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join("; ")}`);
      }
    })();
    return this.closing;
  }
  /** Run one registered command and settle the ACP prompt after its updates drain. */
  async executeCommand(line, requestSignal) {
    const commands = this.ctx.get("commands");
    if (commands === void 0) throw internalError("the command registry is not available");
    const controller = new AbortController();
    this.commandAbort = controller;
    const signal = requestSignal === void 0 ? controller.signal : AbortSignal.any([requestSignal, controller.signal]);
    try {
      const execution = await commands.execute(this.agent, line, [], signal);
      if (execution === void 0) throw invalidParams(`unknown command: ${line}`);
      await this.drainUpdates();
      return { stopReason: "end_turn" };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      if (this.commandAbort === controller) this.commandAbort = void 0;
    }
  }
  assertActive() {
    if (this.closing !== void 0) throw invalidParams(`session is closing: ${this.agent.session.id}`);
  }
  cancelPrompt(detail) {
    const inflight = this.inflight;
    if (inflight === void 0) return;
    inflight.cancelRequested = true;
    inflight.admissionController.abort(new Error(detail));
    this.settleAfterQuiescence(inflight);
    if (inflight.messageQueued) this.agent.cancel({ kind: "user" });
  }
  settleAfterQuiescence(inflight) {
    if (inflight.settlementStarted) return;
    inflight.settlementStarted = true;
    void (async () => {
      await inflight.admissionDone;
      if (inflight.messageQueued) {
        await this.agent.whenIdle();
        await this.outputTail;
      }
      if (this.inflight !== inflight) return;
      this.inflight = void 0;
      if (inflight.cancelRequested) {
        inflight.resolve("cancelled");
        return;
      }
      if (inflight.outputError !== void 0) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`));
        return;
      }
      if (inflight.agentError !== void 0) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`));
        return;
      }
      const end = inflight.endReason;
      if (end === void 0) {
        inflight.resolve("cancelled");
      } else if (end.kind === "error") {
        inflight.reject(internalError(`turn failed: ${end.error.message}`));
      } else {
        inflight.resolve(turnEndToStopReason(end));
      }
    })().catch((error) => {
      if (this.inflight !== inflight) return;
      this.inflight = void 0;
      inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`));
    });
  }
  /** Serialize one notification without letting failure wedge the queue. */
  enqueue(delivery) {
    const previous = this.outputTail;
    this.outputTail = previous.then(delivery).catch((error) => {
      this.ctx.logger.warn(`acp-plus: session update failed: ${errorChain(error)}`);
    });
  }
};

// src/index.ts
var name = "acp-plus";
var inject = ["agents", "llm", "sessionPersistence", "sessions"];
function invalidParams2(detail) {
  return RequestError2.invalidParams(void 0, detail);
}
function internalError2(detail) {
  return RequestError2.internalError(void 0, detail);
}
function apply(ctx, config) {
  const spec = resolveSpec(config);
  const persistence = ctx.sessionPersistence;
  const initialSelection = () => {
    if (spec.selection !== void 0) return { ...spec.selection };
    return ctx.get("agentDefaultModel")?.currentSelection();
  };
  const logger = ctx.logger;
  const sessions = /* @__PURE__ */ new Map();
  const activating = /* @__PURE__ */ new Set();
  let closed = false;
  let imagePromptEnabled = false;
  let clientElicitationSupport = false;
  const authorizeWorkspace = async (params) => {
    validateWorkspaceParams(params, spec.features.additionalDirectories);
    if (!spec.features.additionalDirectories) return [];
    try {
      return await authorizeAdditionalDirectories(params.cwd, params.additionalDirectories ?? []);
    } catch (error) {
      if (error instanceof AcpPlusAdditionalDirectoriesError) throw invalidParams2(error.message);
      throw error;
    }
  };
  const ownedRecord = (agent) => {
    const record = sessions.get(agent.session.id);
    return record?.owns(agent) === true ? record : void 0;
  };
  const assertOpen = () => {
    if (closed) throw internalError2("the ACP bridge has been disposed");
  };
  const requireSession = (sessionId) => {
    const record = sessions.get(sessionId);
    if (record === void 0) throw invalidParams2(`unknown session: ${sessionId}`);
    return record;
  };
  const notify = async (notification) => {
    try {
      await conn.notify(methods.client.session.update, notification);
    } catch (error) {
      logger.warn(`acp-plus: session/update failed: ${String(error)}`);
    }
  };
  const cancellation = (signal) => signal === void 0 ? void 0 : { cancellationSignal: signal };
  const elicitationHost = {
    create: (params, signal) => conn.request(methods.client.elicitation.create, params, cancellation(signal))
  };
  const modesOption = (record) => {
    const modes = record.modeState();
    return modes === void 0 ? {} : { modes };
  };
  const publishCommandsAfterResponse = (record) => {
    const timer = setTimeout(() => {
      record.publishCommands();
    }, 0);
    timer.unref?.();
  };
  ctx.on("user-questions/request", (request, next) => {
    if (!clientElicitationSupport || request.agent === void 0) return next();
    const record = ownedRecord(request.agent);
    if (record === void 0) return next();
    return answerWithElicitation(elicitationHost, record.agent.session.id, request);
  });
  ctx.on("commands/change", () => {
    for (const record of sessions.values()) record.publishCommands();
  });
  ctx.on("session/event", (session, event) => {
    const record = sessions.get(session.header.id);
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event);
  });
  ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn);
  });
  ctx.on("agent/error", ({ agent, turn, error }) => {
    ownedRecord(agent)?.onAgentError(turn, error);
  });
  ctx.on("llm/adapters-updated", () => {
    for (const record of sessions.values()) record.topologyChanged();
  });
  ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent);
    if (record === void 0 || request.callId === void 0) return next();
    const callId = request.callId;
    return record.drainUpdates().then(async () => {
      if (request.reason?.startsWith("escalate sandbox to ") === true && await record.isPreApprovedEscalation(request.toolName, callId)) return "allowed-once";
      const params = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      };
      const { outcome } = await conn.request(methods.client.session.requestPermission, params);
      if (outcome.outcome === "cancelled") return "cancelled";
      return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
    });
  });
  const implementation = {
    async initialize(params) {
      const initial = initialSelection();
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, initial?.provider, initial?.model);
      clientElicitationSupport = params.clientCapabilities?.elicitation?.form != null;
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "dsh-acp-plus", version: "0.1.0" },
        agentCapabilities: {
          // `load` is this bridge's increment over native `resume`; it is only
          // advertised when the deployment opted in and the handler serves it.
          ...spec.features.sessionLoad ? { loadSession: true } : {},
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: {
            close: {},
            list: {},
            resume: {},
            ...spec.features.additionalDirectories ? { additionalDirectories: {} } : {}
          }
        },
        authMethods: [],
        // Advertise the steering extension: clients that speak it (zeron and
        // the org ACP adapters) inject mid-turn text through
        // `_session/steering` instead of cancel-and-reprompt.
        _meta: steeringInitializeMeta()
      };
    },
    authenticate(_params) {
      return Promise.resolve();
    },
    async newSession(params, signal) {
      assertOpen();
      const additionalDirectories = await authorizeWorkspace(params);
      const sessionId = brandString(randomUUID());
      let record;
      try {
        record = await AcpPlusSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          additionalDirectories,
          agentOptions: agentOptions(spec),
          fallbackSelection: initialSelection(),
          signal,
          notify
        });
      } catch (error) {
        if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
          throw invalidParams2(error.message);
        }
        throw error;
      }
      if (closed) {
        await record.close("connection closed during session/new");
        throw internalError2("connection closed during session/new");
      }
      sessions.set(sessionId, record);
      try {
        const configOptions = await record.configOptions(signal);
        assertOpen();
        await ctx.sessions.flush(record.agent.session);
        assertOpen();
        publishCommandsAfterResponse(record);
        return { sessionId, configOptions, ...modesOption(record) };
      } catch (error) {
        sessions.delete(sessionId);
        await record.close("session/new activation failed");
        throw error;
      }
    },
    async listSessions(params, signal) {
      assertOpen();
      if (params.cwd !== void 0 && params.cwd !== null && !isAbsolute3(params.cwd)) {
        throw invalidParams2(`cwd must be an absolute path: ${params.cwd}`);
      }
      let cursor;
      try {
        cursor = decodeSessionListCursor(params.cursor);
      } catch (error) {
        throw invalidParams2(error.message);
      }
      const listed = await persistence.list({ signal });
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (sessions.has(header.id) || activating.has(header.id) || ctx.sessions.get(header.id) !== void 0 || header.origin === "subagent" || header.parentSession !== void 0 || header.cwd === void 0 || !isAbsolute3(header.cwd)) return void 0;
        if (params.cwd !== void 0 && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return void 0;
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt };
      }));
      const entries = filtered.filter((entry) => entry !== void 0).sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId));
      const remaining = cursor === void 0 ? entries : entries.filter((entry) => isAfterSessionListCursor(entry, cursor));
      const page = remaining.slice(0, spec.sessionListPageSize);
      const next = remaining.length > page.length ? page.at(-1) : void 0;
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === void 0 ? {} : { nextCursor: encodeSessionListCursor(next) }
      };
    },
    async resumeSession(params, signal) {
      assertOpen();
      const additionalDirectories = await authorizeWorkspace(params);
      const sessionId = brandString(params.sessionId);
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== void 0) {
        throw invalidParams2(`session is already active: ${sessionId}`);
      }
      activating.add(sessionId);
      return (async () => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header;
        if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) {
          throw invalidParams2(`session is not resumable: ${sessionId}`);
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams2(`session cwd does not match: ${params.cwd}`);
        }
        let record;
        try {
          record = await AcpPlusSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            additionalDirectories,
            agentOptions: agentOptions(spec),
            fallbackSelection: initialSelection(),
            signal,
            notify
          });
        } catch (error) {
          if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
            throw invalidParams2(error.message);
          }
          throw error;
        }
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close("session/resume cwd mismatch");
          throw invalidParams2(`session cwd does not match: ${params.cwd}`);
        }
        if (closed) {
          await record.close("connection closed during session/resume");
          throw internalError2("connection closed during session/resume");
        }
        sessions.set(sessionId, record);
        try {
          publishCommandsAfterResponse(record);
          return { configOptions: await record.configOptions(signal), ...modesOption(record) };
        } catch (error) {
          sessions.delete(sessionId);
          await record.close("session/resume option discovery failed");
          throw error;
        }
      })().finally(() => {
        activating.delete(sessionId);
      });
    },
    async loadSession(params, signal) {
      assertOpen();
      if (!spec.features.sessionLoad) throw invalidParams2("session/load is not enabled by this deployment");
      const additionalDirectories = await authorizeWorkspace(params);
      const sessionId = brandString(params.sessionId);
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== void 0) {
        throw invalidParams2(`session is already active: ${sessionId}`);
      }
      activating.add(sessionId);
      return (async () => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header;
        if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) {
          throw invalidParams2(`session is not loadable: ${sessionId}`);
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams2(`session cwd does not match: ${params.cwd}`);
        }
        await replaySession(ctx, sessionId, (notification) => {
          if (closed) return Promise.reject(internalError2("connection closed during session/load"));
          return notify(notification);
        }, signal);
        let record;
        try {
          record = await AcpPlusSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            additionalDirectories,
            agentOptions: agentOptions(spec),
            fallbackSelection: initialSelection(),
            signal,
            notify
          });
        } catch (error) {
          if (error instanceof AcpPlusMcpConfigError || error instanceof AcpPlusAdditionalDirectoriesError) {
            throw invalidParams2(error.message);
          }
          throw error;
        }
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close("session/load cwd mismatch");
          throw invalidParams2(`session cwd does not match: ${params.cwd}`);
        }
        if (closed) {
          await record.close("connection closed during session/load");
          throw internalError2("connection closed during session/load");
        }
        const pressure = usageUpdate(ctx, record.agent.session);
        if (pressure !== void 0) await notify({ sessionId, update: pressure });
        sessions.set(sessionId, record);
        try {
          publishCommandsAfterResponse(record);
          return { configOptions: await record.configOptions(signal), ...modesOption(record) };
        } catch (error) {
          sessions.delete(sessionId);
          await record.close("session/load option discovery failed");
          throw error;
        }
      })().finally(() => {
        activating.delete(sessionId);
      });
    },
    setSessionMode(params) {
      assertOpen();
      const record = requireSession(brandString(params.sessionId));
      try {
        record.setMode(params.modeId);
      } catch (error) {
        if (error instanceof AcpPlusSessionModeError) throw invalidParams2(error.message);
        throw error;
      }
      return {};
    },
    async setSessionConfigOption(params, signal) {
      assertOpen();
      const record = requireSession(brandString(params.sessionId));
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) };
      } catch (error) {
        if (error instanceof AcpPlusModelConfigError) throw invalidParams2(error.message);
        throw error;
      }
    },
    /**
     * Serve the `_session/steering` extension: inject text into the live turn,
     * or hand it back for normal prompt admission when nothing is running.
     */
    steerSession(params) {
      assertOpen();
      if (typeof params.sessionId !== "string" || params.sessionId === "") {
        throw invalidParams2("_session/steering requires a sessionId");
      }
      const record = requireSession(brandString(params.sessionId));
      const text = steeringText(params.prompt);
      if (text === void 0) return { outcome: "promptRequired", reason: "noRunningTurn" };
      return record.steer(text) ? { outcome: "injected" } : { outcome: "promptRequired", reason: "noRunningTurn" };
    },
    async closeSession(params) {
      assertOpen();
      const sessionId = brandString(params.sessionId);
      const record = requireSession(sessionId);
      try {
        await record.close("ACP session closed");
      } catch (error) {
        throw internalError2(`session close failed: ${errorChain2(error)}`);
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId);
      }
      return {};
    },
    async prompt(params, requestSignal) {
      assertOpen();
      const record = requireSession(brandString(params.sessionId));
      return record.prompt(params, imagePromptEnabled, requestSignal);
    },
    cancel(params) {
      sessions.get(brandString(params.sessionId))?.cancel();
      return Promise.resolve();
    }
  };
  const stream = spec.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin)
  );
  const app = createAcpAgentApp({ name: "dsh-acp-plus" }).onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params)).onRequest(methods.agent.authenticate, async ({ params }) => {
    await implementation.authenticate(params);
    return {};
  }).onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal)).onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal)).onRequest(methods.agent.session.load, ({ params, signal }) => implementation.loadSession(params, signal)).onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal)).onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params)).onRequest(methods.agent.session.setMode, ({ params }) => implementation.setSessionMode(params)).onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal)).onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal)).onRequest(STEERING_METHOD, parseSteeringRequest, ({ params }) => implementation.steerSession(params)).onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params));
  const connection = app.connect(stream);
  const conn = connection.client;
  let quiescing;
  const quiesce = () => {
    if (quiescing !== void 0) return quiescing;
    closed = true;
    const records = [...sessions.values()];
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map((record) => record.close("ACP bridge disposed")));
      for (const record of records) {
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id);
      }
      const failures = [];
      for (const result of disposals) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length > 0) {
        const detail = failures.map((failure) => errorChain2(failure)).join("; ");
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`
        );
      }
    })();
    return quiescing;
  };
  void connection.closed.catch((error) => {
    logger.warn(`acp-plus: connection closed with an error: ${String(error)}`);
  }).then(quiesce).catch((error) => {
    logger.warn(`acp-plus: connection-close teardown failed: ${String(error)}`);
  });
  ctx.effect(() => quiesce, "acp-plus.connection");
}
function agentOptions(spec) {
  return {
    ...spec.provider !== void 0 ? { provider: spec.provider } : {},
    ...spec.model !== void 0 ? { model: spec.model } : {}
  };
}
function decodeSessionListCursor(value) {
  if (value === void 0 || value === null) return void 0;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("session/list cursor is invalid");
  try {
    const decoded = JSON.parse(Buffer2.from(value, "base64url").toString("utf8"));
    const createdAt = Array.isArray(decoded) ? decoded[0] : void 0;
    const sessionId = Array.isArray(decoded) ? decoded[1] : void 0;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 || typeof sessionId !== "string" || sessionId.length === 0) throw new Error("invalid cursor fields");
    const canonical = Buffer2.from(JSON.stringify(decoded), "utf8").toString("base64url");
    if (canonical !== value) throw new Error("non-canonical cursor");
    return { createdAt, sessionId };
  } catch (_invalidCursor) {
    throw new Error("session/list cursor is invalid");
  }
}
function encodeSessionListCursor(entry) {
  return Buffer2.from(JSON.stringify([entry.createdAt, entry.sessionId]), "utf8").toString("base64url");
}
function isAfterSessionListCursor(entry, cursor) {
  return entry.createdAt < cursor.createdAt || entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0;
}
function compareSessionIds(left, right) {
  return Buffer2.compare(Buffer2.from(left), Buffer2.from(right));
}
function validateWorkspaceParams(params, additionalDirectories) {
  if (!isAbsolute3(params.cwd)) throw invalidParams2(`cwd must be an absolute path: ${params.cwd}`);
  if (!additionalDirectories && params.additionalDirectories !== void 0 && params.additionalDirectories !== null && params.additionalDirectories.length > 0) {
    throw invalidParams2("additionalDirectories is not supported");
  }
}
async function sameDirectory(left, right) {
  if (left === void 0) return false;
  try {
    const [realLeft, realRight] = await Promise.all([realpath2(left), realpath2(right)]);
    return realLeft === realRight;
  } catch (_unresolvablePath) {
    return resolve2(left) === resolve2(right);
  }
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
