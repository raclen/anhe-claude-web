import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  IDLE_TIMEOUT_MS,
  MAX_ACTIVE_SESSIONS,
  SESSION_DIR_OVERRIDE,
} from "../config.ts";
import {
  asCanUseToolRequest,
  decideAllowOnce,
  decideAlwaysAllow,
  decideDeny,
  errorResponse,
  fallbackRule,
  interruptCommand,
  isControlRequest,
  isPermissionMode,
  setModelCommand,
  setPermissionModeCommand,
  successResponse,
  type CanUseToolResponse,
  type PermissionMode,
  type PermissionUpdate,
} from "./controls.ts";
import { makeDraftPath } from "../session-path.ts";
import { readSessionSnapshot as readSnapshot } from "../session-reader.ts";
import { writeTranscriptHtml } from "../transcript-html.ts";
import { locateClaudeCli, type ClaudeCli } from "./locate.ts";

/**
 * fork 新会话时必须发出的第一句话。
 *
 * Claude Code 的 `--fork-session` 只在跑完一轮之后才把新 jsonl 写出来，而 `-p`
 * 模式的 `system:init` 也要等第一条 prompt。所以「只复制历史、不说任何话」在
 * 这个 CLI 上做不到 —— 这句话是新会话里唯一的代价，写在 known-limitations 里。
 */
const FORK_OPENER = "（这是从已有会话分叉出来的新会话，请忽略这条消息。）";
import { Normalizer, type NormalizedEvent } from "./normalize.ts";

/**
 * 一条斜杠命令。`builtin` 从不由 CLI 上报 —— 那些命令由客户端实现，
 * 由 `commands.ts` 合并进来。
 */
export interface SlashCommand {
  /** 不带前导斜杠的命令名。 */
  name: string;
  description?: string;
  /** 来源，决定它在补全菜单里归到哪一段。 */
  source: "builtin" | "extension" | "prompt" | "skill";
}

/** 前端消费的一条归一化事件（含 `session_init` 与控制结果）。 */
export type SessionEventListener = (handle: SessionHandle, event: NormalizedEvent) => void;

/** 一个等待用户决定的权限请求。 */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  displayName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  description: string | null;
  blockedPath: string | null;
  toolKind: string | null;
  requiresUserInteraction: boolean;
  requestedAt: number;
  /** CLI 建议的持久化规则；「总是允许」优先采用它建议的粒度。 */
  suggestions: PermissionUpdate[] | undefined;
}

export interface SessionHandle {
  /** 会话 jsonl 的绝对路径；在 `system:init` 之后才确定。 */
  sessionPath: string;
  sessionId: string;
  /** 项目目录；即子进程的 cwd。 */
  projectPath: string;
  /** 子进程。 */
  child: ChildProcessWithoutNullStreams;
  cli: ClaudeCli;
  startedAt: number;
  lastActivityAt: number;
  normalizer: Normalizer;
  /** 是否已经收到过 `system:init`。 */
  initialized: boolean;
  /** 当前权限模式（本地记账，切换时同步写回 CLI）。 */
  permissionMode: PermissionMode;
  /** 正在等待用户决定的权限请求，按 requestId 索引。 */
  pending: Map<string, PendingPermission>;
  /** 已发出但没等到 `control_response` 的请求 id。 */
  controlWaiters: Map<string, (payload: Record<string, unknown>) => void>;
  /** 本轮是否还在进行（用于中断与前端状态）。 */
  streaming: boolean;
  /** `--resume` 用的原始会话 id。 */
  resumeId: string | null;
  /** `system:init.model` 报的模型。运行中会话的权威模型来源。 */
  initModel: string | null;
  /** 最近一轮的上下文 token 数（来自 `assistant.message.usage`）。 */
  lastUsage: number | null;
  /** `system:init.slash_commands`。进程启动前为 null。 */
  slashCommands: string[] | null;
  /** 已失效的句柄。routes 见到它就重开。 */
  dead: boolean;
  /**
   * 与 pi-web 的 `RpcClient` 同形的门面。
   *
   * routes.ts 是从 pi-web 移植的，围绕 `handle.client.xxx()` 写了一整套调用点。
   * 这里提供一个同形对象，让那 1800 行不用改；协议知识仍然只在本目录里。
   */
  client: SessionClient;
}

/** routes 需要的 RPC 面。全部是异步的，与 pi 的 `RpcClient` 形状一致。 */
export interface SessionClient {
  prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  steer(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  abort(): Promise<void>;
  getMessages(): Promise<unknown[]>;
  getForkMessages(): Promise<unknown[]>;
  fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  getState(): Promise<{
    model: { provider: string; id: string } | null;
    thinkingLevel: string;
    isStreaming: boolean;
    isCompacting: boolean;
    sessionFile: string | null;
    sessionId: string;
    sessionName: string | null;
    messageCount: number;
    pendingMessageCount: number;
    autoCompactionEnabled: boolean;
  }>;
  setModel(provider: string, id: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setSessionName(name: string): Promise<void>;
  /** `/compact [说明]`。走 CLI 自己的压缩命令。 */
  compact(instructions?: string): Promise<{
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }>;
  /** `/export [路径]`。本项目自己写 HTML，不经 CLI。 */
  exportHtml(target?: string): Promise<{ path: string }>;
  /** `/session`。从 jsonl 统计。 */
  getSessionStats(): Promise<{
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    tokens: { total: number };
    cost: number;
  }>;
}

export interface SessionRegistryOptions {
  idleTimeoutMs?: number;
  maxActiveSessions?: number;
  /**
   * 额外的 `--settings <path>`。
   *
   * 用途：验收时用一个临时 settings 覆盖上游，绝不碰用户的 `~/.claude/settings.json`。
   * 也允许高级用户显式指向另一份配置（实测 `settings.json` 的 `env` 优先级高于
   * 进程环境变量，所以想换上游**只能**靠 `--settings`，改 env 无效）。
   *
   * 产品上不主动给普通用户暴露这个开关 —— 默认永远是 null，即用用户自己的配置。
   */
  settingsPath?: string | null;
}

/** 权限卡的回答。 */
export interface PermissionAnswer {
  behavior: "allow" | "deny";
  /** 允许一次 / 总是允许 / 拒绝。 */
  classification: "user_temporary" | "user_permanent" | "user_reject";
  /** 拒绝时回给模型的原因。 */
  message?: string;
  /** 拒绝时是否同时中断本轮。 */
  interrupt?: boolean;
  /** 允许时可改写工具入参（不传则原样）。 */
  updatedInput?: Record<string, unknown>;
}

export class SessionRegistryError extends Error {
  readonly code: "no-cli" | "max-sessions" | "spawn-failed" | "no-session" | "bad-answer";
  constructor(code: SessionRegistryError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 每会话一个 `claude` 子进程的注册表。
 *
 * 为什么一进程一会话：`claude -p --input-format stream-json` 是**双向**的，一轮
 * 结束后进程仍然活着，可以继续喂下一轮，会话上下文留在进程内存里。这个模型
 * 与 pi 的 RPC 模式形状一致，所以空闲回收、并发上限、预热这些机制能原样保留。
 *
 * 为什么单写者：往 stdin 写必须是原子的、按行序列化的。多个 HTTP 请求同时写
 * 一个子进程会交错出半行 JSON，CLI 侧直接解析失败。所以所有写都过 `writeLine`。
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionHandle>();
  /**
   * 别名表：`draft:<项目>` → 句柄当前的真实路径。
   *
   * 前端在第一条消息之前只认识 draft 键，而句柄一旦拿到 `system:init` 就会
   * 迁到 jsonl 路径。留一张别名表，用户再用 draft 键发消息时能找回同一个进程，
   * 而不是又开一个。
   */
  private readonly aliases = new Map<string, string>();
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleTimeoutMs: number;
  private readonly maxActiveSessions: number;
  private readonly settingsPath: string | null;

  constructor(options: SessionRegistryOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS;
    this.settingsPath =
      options.settingsPath ?? process.env.ANHE_CLAUDE_WEB_SETTINGS ?? null;
  }

  onEvent(listener: SessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 会话路径 → 句柄。未启动则 undefined。 */
  get(sessionPath: string): SessionHandle | undefined {
    return this.sessions.get(sessionPath);
  }

  /**
   * 真实的活动会话数。
   *
   * 不能直接用 `sessions.size`：别名表里 `draft:<项目>` 和真实 jsonl 路径指向
   * 同一个句柄，会让计数翻倍，从而过早触发「开太多了」的回收。
   */
  private activeCount(): number {
    return new Set(this.sessions.values()).size;
  }

  /** 所有活着的句柄。别名会让同一个句柄出现多次，这里去重。 */
  list(): SessionHandle[] {
    return [...new Set(this.sessions.values())];
  }

  /** 某个会话当前挂着的权限请求（用于刷新后恢复权限卡）。 */
  pendingPermissions(sessionPath: string): PendingPermission[] {
    const handle = this.sessions.get(sessionPath);
    return handle === undefined ? [] : [...handle.pending.values()];
  }

  /**
   * 新建一个会话进程。
   *
   * **会话 id 必须等 `system:init`**：实测 `--session-id` 不生效，CLI 会忽略它并
   * 自己生成一个。所以在 init 到达之前，句柄用 `projectPath` 作为临时键，
   * 拿到 id 后再迁到真正的 `sessionPath`。
   */
  async create(projectPath: string, options: { prompt?: string; permissionMode?: PermissionMode } = {}): Promise<SessionHandle> {
    if (this.activeCount() >= this.maxActiveSessions) {
      await this.evictOldest();
    }
    const cli = await this.requireCli();
    const handle = await this.spawnProcess({
      cli,
      projectPath: resolve(projectPath),
      sessionId: null,
      permissionMode: options.permissionMode ?? "default",
    });
    // **临时键用 `draft:<项目路径>`，不是裸项目路径。**
    // 前端在第一条消息之前就要订阅这个会话的 SSE（否则会漏掉 `session_init`），
    // 而订阅是按 `sessionPath` 过滤的 —— 用裸项目路径当键会和「会话路径」混淆：
    // 同一个项目开两个会话，两次都会撞上同一个键。
    // `draft:` 前缀也是 `routes.ts` 里 `isDraftPath` 认的形状，两边一致。
    this.track(handle, makeDraftPath(handle.projectPath), { provisional: true });
    // **不在这里等 `system:init`。** 实测：`-p` 模式下 CLI 要等到第一条 prompt
    // 才开始发 init，空等 15 秒只会让「新建会话」这个动作慢 15 秒。
    // 会话 id 在第一轮 `send()` 之后由 `onLine` 填入并迁移路径；
    // 需要 id 的调用方（发消息、读状态）本来就在那之后。
    return handle;
  }

  /**
   * 等一个句柄拿到 `system:init`。
   *
   * 超时不算失败：CLI 可能因为上游慢而迟迟不发 init。此时返回的句柄仍然可用，
   * 只是 `sessionId` 还是空的；调用方应当把「没有 id」当成「还没准备好」而不是错误。
   */
  private async waitForInit(handle: SessionHandle, timeoutMs: number): Promise<void> {
    if (handle.initialized) return;
    await new Promise<void>((resolveWait) => {
      const deadline = setTimeout(() => {
        unsubscribe();
        resolveWait();
      }, timeoutMs);
      deadline.unref?.();
      const unsubscribe = this.onEvent((candidate, event) => {
        if (candidate !== handle) return;
        if (event.type !== "session_init") return;
        clearTimeout(deadline);
        unsubscribe();
        resolveWait();
      });
    });
  }

  /**
   * 续上一个已有会话（`--resume`）。
   *
   * 冷启动约 1–2 秒。若该会话的进程还活着，直接返回它 —— 这就是「空闲回收后
   * 再发消息自动重开」的落点。
   */
  async resume(sessionPath: string, projectPath: string): Promise<SessionHandle> {
    const existing = this.sessions.get(sessionPath);
    if (existing !== undefined) {
      this.touch(existing);
      return existing;
    }
    if (this.activeCount() >= this.maxActiveSessions) {
      await this.evictOldest();
    }
    const cli = await this.requireCli();
    const sessionId = sessionPath.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") ?? null;
    if (sessionId === null || sessionId.length === 0) {
      throw new SessionRegistryError("no-session", `无法从路径解析会话 id：${sessionPath}`);
    }
    const handle = await this.spawnProcess({
      cli,
      projectPath: resolve(projectPath),
      sessionId,
      permissionMode: "default",
    });
    // `--resume` 同样要等第一条 prompt 才发 `system:init`（实测），所以不阻塞。
    // 句柄的 sessionPath 已经是我们传进来的那个文件，id 也已知 —— 不缺信息。
    this.track(handle, sessionPath, { provisional: false });
    handle.initialized = true;
    return handle;
  }

  /**
   * 发一轮用户消息。
   *
   * 形状来自实测：stdin 每行一个 JSON，`type: "user"` + Anthropic 的 message 结构。
   */
  async send(
    handle: SessionHandle,
    text: string,
    images: Array<{ data: string; mimeType: string }> = [],
  ): Promise<void> {
    const content: Array<Record<string, unknown>> = [];
    if (text.trim().length > 0) content.push({ type: "text", text });
    for (const image of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      });
    }
    handle.streaming = true;
    // 前端要立刻知道本轮开始了（用来锁输入框、开计时器），不能等 CLI 的第一个事件。
    // 只在这里发：Normalizer 不再发 `agent_start`，否则一次发送会出现两条。
    handle.normalizer.markStreamStarted();
    this.emit(handle, { type: "agent_start" });
    this.writeLine(handle, {
      type: "user",
      message: { role: "user", content },
    });
    this.touch(handle);
  }

  /** 中断当前轮。 */
  interrupt(sessionPath: string): boolean {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return false;
    this.writeLine(handle, interruptCommand());
    this.touch(handle);
    return true;
  }

  /** 切换权限模式。会话级状态，新会话永远从 default 开始。 */
  setPermissionMode(sessionPath: string, mode: PermissionMode): boolean {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return false;
    this.writeLine(handle, setPermissionModeCommand(mode));
    handle.permissionMode = mode;
    this.touch(handle);
    return true;
  }

  /** 切换模型。 */
  setModel(sessionPath: string, model: string): boolean {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return false;
    this.writeLine(handle, setModelCommand(model));
    this.touch(handle);
    return true;
  }

  /**
   * 回答一张权限卡。
   *
   * 三个按钮的语义差异全在 `controls.ts` 里，这里只负责把响应包好写回去。
   * 响应必须是 `control_response` 信封 + 嵌套 `response`，写错过一次。
   */
  answerPermission(
    sessionPath: string,
    requestId: string,
    answer: PermissionAnswer,
  ): boolean {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return false;
    const pending = handle.pending.get(requestId);
    if (pending === undefined) return false;

    let response: CanUseToolResponse;
    if (answer.behavior === "allow") {
      const input = answer.updatedInput ?? pending.input;
      if (answer.classification === "user_permanent") {
        response = decideAlwaysAllow(
          input,
          pending.suggestions,
          fallbackRule({
            subtype: "can_use_tool",
            tool_name: pending.toolName,
            input: pending.input,
            tool_use_id: pending.toolUseId,
          }),
        );
      } else {
        response = decideAllowOnce(input);
      }
    } else {
      response = decideDeny({ message: answer.message, interrupt: answer.interrupt });
    }

    this.writeLine(handle, successResponse(requestId, response));
    handle.pending.delete(requestId);
    this.emit(handle, handle.normalizer.permissionResolved(requestId, answer.behavior));
    this.touch(handle);
    return true;
  }

  /** 停掉一个会话进程。 */
  stop(sessionPath: string, reason = "stopped"): void {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return;
    this.dispose(handle, reason);
  }

  /** 关掉全部进程（服务退出时）。 */
  shutdown(): void {
    for (const handle of [...this.sessions.values()]) {
      this.dispose(handle, "server_shutdown");
    }
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  // -- 内部 ----------------------------------------------------------------

  private async requireCli(): Promise<ClaudeCli> {
    const located = await locateClaudeCli();
    if (!located.ok) {
      throw new SessionRegistryError("no-cli", located.message);
    }
    return located.cli;
  }

  /**
   * 拉起子进程。
   *
   * 参数选择说明：
   * - `-p`：非交互。配合双向 stream-json 才能持续喂轮次。
   * - `--input-format stream-json` + `--output-format stream-json`：双向 JSONL。
   * - `--include-partial-messages`：打开 `stream_event` 增量，打字机效果的来源。
   *   上游不转发 SSE 时也不会坏事，`normalize.ts` 会退化成整条更新。
   * - `--verbose`：必需的，否则流式模式下 CLI 会拒绝启动。
   * - **绝不加 `--dangerously-skip-permissions`**（SECURITY.md 硬边界 2）。
   * - `--permission-mode` 只在显式要求时传，默认不传 —— 让 CLI 用用户自己的配置。
   */
  private async spawnProcess(input: {
    cli: ClaudeCli;
    projectPath: string;
    sessionId: string | null;
    permissionMode: PermissionMode;
  }): Promise<SessionHandle> {
    if (!existsSync(input.projectPath)) {
      throw new SessionRegistryError("spawn-failed", `项目目录不存在：${input.projectPath}`);
    }

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      // 注意：不要加 `--permission-prompts host`。
      // 实测（FINDINGS.md 第 11 节）：`can_use_tool` 只对 Anthropic 认可的 SDK 宿主开放，
      // 而 `--sdk-url` 会以 "host is not an approved Anthropic endpoint" 被拒。
      // 所以这个版本的 CLI 无法把权限提问接到本进程 —— 权限一律由 CLI 自己按
      // 用户 settings.json 的 permissions 规则判定，被拒时它发
      // `system:permission_denied`，我们如实展示（见 normalize.ts）。
    ];
    if (input.sessionId !== null) args.push("--resume", input.sessionId);
    if (input.permissionMode !== "default") {
      args.push("--permission-mode", input.permissionMode);
    }
    // 实测：settings.json 的 env 优先级高于进程环境变量，换上游只能靠 --settings。
    if (this.settingsPath !== null && this.settingsPath.length > 0) {
      args.push("--settings", this.settingsPath);
    }

    const child = spawn(input.cli.path, args, {
      cwd: input.projectPath,
      env: {
        ...process.env,
        // 关掉 CLI 自己的花哨输出，我们读 JSONL。
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows 上不经 shell：cli.path 已经是原生 exe。走 shell 会把 stdout 弄脏。
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    const handle: SessionHandle = {
      sessionPath: "",
      sessionId: input.sessionId ?? "",
      projectPath: input.projectPath,
      child,
      cli: input.cli,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      normalizer: new Normalizer(),
      initialized: false,
      permissionMode: input.permissionMode,
      pending: new Map(),
      controlWaiters: new Map(),
      streaming: false,
      resumeId: input.sessionId,
      initModel: null,
      lastUsage: null,
      slashCommands: null,
      dead: false,
      client: null as unknown as SessionClient,
    };

    handle.client = this.makeClient(handle);
    this.attachStdio(handle);
    return handle;
  }

  /** 接管 stdout / stderr。 */
  private attachStdio(handle: SessionHandle): void {
    // stdout：每行一个事件。
    const out = createInterface({ input: handle.child.stdout, crlfDelay: Infinity });
    out.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        // CLI 偶尔会在 stdout 打非 JSON 的东西（警告、进度条残留）。忽略。
        return;
      }
      this.onLine(handle, raw);
    });

    // stderr：只留最后几行用于报错，其余丢弃 —— 里面可能有路径，但不应该有密钥。
    const errLines: string[] = [];
    const err = createInterface({ input: handle.child.stderr, crlfDelay: Infinity });
    err.on("line", (line) => {
      if (line.trim().length === 0) return;
      errLines.push(line);
      if (errLines.length > 40) errLines.shift();
    });

    handle.child.on("error", (error) => {
      const reason =
        error.message.includes("ENOENT")
          ? `启动 Claude Code 失败（ENOENT）：${handle.cli.path}`
          : `子进程错误：${error.message}`;
      this.dispose(handle, reason);
    });

    handle.child.on("exit", (code, signal) => {
      const tail = errLines.slice(-3).join(" / ");
      const reason =
        code === 0 || signal !== null
          ? "session_ended"
          : `子进程退出（code ${code}）${tail.length > 0 ? `：${tail}` : ""}`;
      this.dispose(handle, reason);
    });

    handle.child.stdin.on("error", () => {
      // 写已关闭的 stdin 会抛 EPIPE；exit 处理器会收拾残局。
    });
  }

  /** 处理一行来自 CLI 的输出。 */
  private onLine(handle: SessionHandle, raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const event = raw as Record<string, unknown>;

    // 控制平面先拦：它不进消息流。
    if (event.type === "control_response") {
      const response = event.response as Record<string, unknown> | undefined;
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      if (requestId !== null) {
        const waiter = handle.controlWaiters.get(requestId);
        if (waiter !== undefined) {
          handle.controlWaiters.delete(requestId);
          waiter(response ?? {});
        }
      }
      return;
    }

    if (isControlRequest(event)) {
      const canUse = asCanUseToolRequest(event);
      if (canUse !== null) {
        const requestId = event.request_id;
        handle.pending.set(requestId, {
          requestId,
          toolName: canUse.tool_name,
          displayName: canUse.display_name ?? canUse.tool_name,
          input: canUse.input,
          toolUseId: canUse.tool_use_id,
          description: canUse.description ?? null,
          blockedPath: canUse.blocked_path ?? null,
          toolKind: canUse.tool_kind ?? null,
          requiresUserInteraction: canUse.requires_user_interaction === true,
          requestedAt: Date.now(),
          suggestions: canUse.permission_suggestions,
        });
        this.emit(handle, handle.normalizer.permissionRequest(requestId, canUse));
        this.touch(handle);
        return;
      }
      // 其它控制请求（`request_user_dialog` 等）第一版不接，回一个 error 让 CLI 走
      // 它自己的默认路径，而不是卡死等我们。
      this.writeLine(handle, errorResponse(event.request_id, "not supported by anhe-claude-web"));
      return;
    }

    // `system:init` 决定会话身份。这是唯一的权威来源。
    if (event.type === "system" && event.subtype === "init") {
      const sessionId = typeof event.session_id === "string" ? event.session_id : "";
      if (sessionId.length > 0) {
        const previousPath = handle.sessionPath;
        handle.sessionId = sessionId;
        handle.sessionPath = this.sessionPathFor(handle.projectPath, sessionId);
        if (previousPath !== handle.sessionPath) {
          // 从临时键迁到真键。句柄对象同一个，监听者按路径过滤。
          this.sessions.delete(previousPath);
          this.sessions.set(handle.sessionPath, handle);
          // **必须广播改名。** 前端在拿到会话 id 之前订阅的是 `draft:<项目>`，
          // 它没有别的办法知道这个会话落到了哪个 jsonl 上 —— 不发这条，
          // 前端会一直停在 draft 路径上，后面每一条事件都收不到。
          this.emit(handle, {
            type: "session_renamed",
            previousPath,
            sessionPath: handle.sessionPath,
            sessionId,
          });
        }
      }
      handle.initialized = true;
      if (isPermissionMode(event.permissionMode)) {
        handle.permissionMode = event.permissionMode;
      }
      if (typeof event.model === "string" && event.model.length > 0) {
        handle.initModel = event.model;
      }
      if (Array.isArray(event.slash_commands)) {
        handle.slashCommands = event.slash_commands.filter(
          (name): name is string => typeof name === "string",
        );
      }
    }

    // 记账上下文用量：每条 assistant 消息的 usage 是权威的窗口占用。
    if (event.type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage !== undefined) {
        const count = (key: string): number =>
          typeof usage[key] === "number" ? (usage[key] as number) : 0;
        const total =
          count("input_tokens") +
          count("cache_read_input_tokens") +
          count("cache_creation_input_tokens") +
          count("output_tokens");
        if (total > 0) handle.lastUsage = total;
      }
    }

    handle.lastActivityAt = Date.now();
    this.touch(handle);

    for (const normalized of handle.normalizer.push(event)) {
      if (normalized.type === "agent_start") handle.streaming = true;
      if (normalized.type === "agent_settled") handle.streaming = false;
      this.emit(handle, normalized);
    }
  }

  /**
   * 会话 id → jsonl 路径。
   *
   * **不推导 slug。** Claude Code 的目录名编码不可反推，实测：
   * `E:\code\Oracle	emp\claude-proto\work`
   *   → `E--code-Oracle-temp-claude-proto-work`
   * 盘符**大写**、分隔符折成单个 `-`、开头补 `--`。跟前缀小写、`:` 也折成 `-` 的
   * 直觉写法差两处，猜一次错一次。
   *
   * 所以这里直接找：文件名就是 `<sessionId>.jsonl`，在 `~/.claude/projects/*` 下
   * 按文件名匹配。找不到才退回到一个尽力而为的路径（文件此时还没落盘）。
   */
  private sessionPathFor(projectPath: string, sessionId: string): string {
    const root = SESSION_DIR_OVERRIDE
      ? resolve(SESSION_DIR_OVERRIDE)
      : this.defaultSessionRoot();

    // 先找已经落盘的那个文件 —— 这是唯一可靠的来源。
    for (const dir of this.projectDirs(root)) {
      const candidate = resolve(dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    // 还没落盘（`system:init` 刚回来、第一轮还没写）：按 CLI 的实际规则拼一个占位。
    //
    // **规则是「每个非字母数字字符各自换成 `-`」，不是把连续的压成一个。**
    // `C:\Users\...` 里 `:` 和 `\` 相邻，所以目录名开头是 `C--Users`；压成一个会得到
    // `C-Users`，与 CLI 实际写入的目录差一个字符 —— 于是同一个会话会被当成两个，
    // 事件路径和磁盘路径对不上，前端整条流都跟丢。这个差异花了一轮调试才认出来。
    const slug = projectPath.replace(/[^A-Za-z0-9]/g, "-");
    return resolve(root, slug, `${sessionId}.jsonl`);
  }

  /** `~/.claude/projects` 下的所有项目目录。 */
  private projectDirs(root: string): string[] {
    try {
      // 同步读：只在 init 时调一次，且后续有同步 existsSync 判断。
      const entries = readdirSync(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(root, entry.name));
    } catch {
      return [];
    }
  }

  private defaultSessionRoot(): string {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    return resolve(home, ".claude", "projects");
  }

  private track(
    handle: SessionHandle,
    key: string,
    options: { provisional: boolean },
  ): void {
    handle.sessionPath = options.provisional ? key : key;
    this.sessions.set(handle.sessionPath, handle);
    this.emit(handle, { type: "session_started", sessionPath: handle.sessionPath });
    this.touch(handle);
  }

  /**
   * 续命空闲计时器。
   *
   * 接受路径或句柄：`routes.ts` 从 pi-web 移植过来，所有调用点传的是路径字符串。
   */
  touch(target: SessionHandle | string): void {
    const handle =
      typeof target === "string" ? this.sessions.get(target) : target;
    if (handle === undefined) return;
    this.touchHandle(handle);
  }

  private touchHandle(handle: SessionHandle): void {
    handle.lastActivityAt = Date.now();
    const key = handle.sessionPath;
    const existing = this.idleTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      const current = this.sessions.get(key);
      if (current === undefined) return;
      // 有卡着的权限请求就不回收：用户可能正看着那张卡。
      if (current.pending.size > 0) {
        this.touchHandle(current);
        return;
      }
      this.dispose(current, "idle_timeout");
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  /** 回收最久没动的一个。 */
  private async evictOldest(): Promise<void> {
    let oldest: SessionHandle | null = null;
    for (const handle of this.sessions.values()) {
      if (oldest === null || handle.lastActivityAt < oldest.lastActivityAt) oldest = handle;
    }
    if (oldest !== null) this.dispose(oldest, "evicted_for_capacity");
  }

  /** 停掉并清账。 */
  private dispose(handle: SessionHandle, reason: string): void {
    const key = handle.sessionPath;
    if (key.length === 0 || this.sessions.get(key) !== handle) {
      // 可能是临时键（init 之前就挂了）。
      for (const [candidateKey, candidate] of this.sessions) {
        if (candidate === handle) this.sessions.delete(candidateKey);
      }
    } else {
      this.sessions.delete(key);
    }
    // 别名指向这个已死的句柄时一并清掉，否则下次 `get(draft:…)` 会拿到死句柄。
    for (const [aliasKey, target] of this.aliases) {
      if (target !== key && this.sessions.get(aliasKey) !== handle) continue;
      this.aliases.delete(aliasKey);
      this.sessions.delete(aliasKey);
    }
    const timer = this.idleTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }

    for (const event of handle.normalizer.finalize(reason)) this.emit(handle, event);

    // 还有卡着的权限请求：告诉前端它们已经无效，不然卡片会永远转圈。
    for (const requestId of handle.pending.keys()) {
      this.emit(handle, { type: "permission_resolved", requestId, behavior: "deny", reason });
    }
    handle.pending.clear();

    try {
      if (!handle.child.killed) handle.child.kill();
    } catch {
      // 已经退出。
    }
    this.emit(handle, { type: "session_closed", sessionPath: key, reason });
  }

  /**
   * 造一个与 pi `RpcClient` 同形的门面。
   *
   * 注意 `fork` 的语义差异：pi 的 fork 是把 leaf 指针移回去，同一份文件里长出
   * 兄弟分支；Claude Code 的 fork 是**另开一个会话文件**（`--resume <id>
   * --fork-session`），原会话一条都不丢。这里按 Claude Code 的语义实现，
   * 返回的是新会话的 id 与提示文本。
   */
  private makeClient(handle: SessionHandle): SessionClient {
    const self = this;
    return {
      async prompt(text, images = []) {
        await self.send(handle, text, images);
      },
      // `steer`（打断当前轮插一句）与 `followUp`（排在当前轮之后）在 Claude
      // Code 的 stream-json 里都是「再写一行 user 消息」，区别由 CLI 自己按
      // 当前是否 streaming 决定。所以两者都走 send。
      async steer(text, images = []) {
        await self.send(handle, text, images);
      },
      async followUp(text, images = []) {
        await self.send(handle, text, images);
      },
      async abort() {
        self.writeLine(handle, interruptCommand());
        self.touch(handle);
      },
      async getMessages() {
        // 进程内视角可能因为压缩而与文件不同，但文件是用户 `claude --resume`
        // 看到的那一份。为了「两边永远一致」，这里一律读文件。
        const snapshot = await readSnapshot(handle.sessionPath);
        return snapshot.messages;
      },
      async getForkMessages() {
        const snapshot = await readSnapshot(handle.sessionPath);
        return snapshot.forkPoints;
      },
      async fork(entryId) {
        // Claude Code 的 fork 粒度是整个会话，不是某一条消息。`entryId` 用来在
        // 原会话里定位「从哪往后分叉」，实际执行的是 fork 整个会话。
        void entryId;
        const forked = await self.forkSession(handle);
        return { text: forked.sessionPath, cancelled: false };
      },
      async getState() {
        return await self.stateOf(handle);
      },
      async setModel(_provider, id) {
        self.writeLine(handle, setModelCommand(id));
        handle.initModel = id;
        self.touch(handle);
      },
      async setAutoCompaction(_enabled) {
        // Claude Code 的自动压缩是它自己的行为，没有对应控制命令。这里明确
        // 不做任何事，并把这次调用视为成功 —— 上层的设置页会显示「本版不可调」。
        self.touch(handle);
      },
      async setSessionName(_name) {
        // Claude Code 的 jsonl 里没有「会话名」这个概念。手动标题存在本项目
        // 自己的 store 里，见 `session-title.ts`。这里什么都不写。
        self.touch(handle);
      },
      async compact(instructions) {
        const before = handle.lastUsage ?? 0;
        // `/compact` 是 CLI 自己的斜杠命令，作为一条 user 消息发过去即可 ——
        // Claude Code 会在 CLI 侧拦截它并执行压缩，不会把它当成普通对话。
        const text = instructions === undefined || instructions.length === 0
          ? "/compact"
          : `/compact ${instructions}`;
        await self.send(handle, text);
        return { tokensBefore: before };
      },
      async exportHtml(target) {
        // 导出成 HTML 是本项目自己的能力：把 jsonl 渲染成一份自包含页面。
        const snapshot = await readSnapshot(handle.sessionPath);
        const path = await writeTranscriptHtml(
          handle.sessionPath,
          snapshot,
          target,
        );
        return { path };
      },
      async getSessionStats() {
        const snapshot = await readSnapshot(handle.sessionPath);
        let userMessages = 0;
        let assistantMessages = 0;
        let toolCalls = 0;
        let tokenTotal = 0;
        for (const message of snapshot.messages) {
          const role = (message as { role?: string }).role;
          if (role === "user") userMessages += 1;
          else if (role === "assistant") {
            assistantMessages += 1;
            const usage = (message as { usage?: Record<string, number> }).usage;
            if (usage !== undefined) {
              tokenTotal +=
                (usage.input ?? 0) +
                (usage.output ?? 0) +
                (usage.cacheRead ?? 0) +
                (usage.cacheWrite ?? 0);
            }
          }
          const content = (message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "toolCall"
              ) {
                toolCalls += 1;
              }
            }
          }
        }
        return {
          totalMessages: snapshot.messages.length,
          userMessages,
          assistantMessages,
          toolCalls,
          tokens: { total: tokenTotal },
          cost: 0,
        };
      },
    };
  }

  /** 把一个会话 fork 成新会话。返回新句柄。 */
  private async forkSession(handle: SessionHandle): Promise<SessionHandle> {
    if (handle.sessionId.length === 0) {
      throw new SessionRegistryError("no-session", "会话还没有 id，无法 fork");
    }
    if (this.activeCount() >= this.maxActiveSessions) await this.evictOldest();

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--resume",
      handle.sessionId,
      "--fork-session",
    ];
    if (this.settingsPath !== null && this.settingsPath.length > 0) {
      args.push("--settings", this.settingsPath);
    }
    const child = spawn(handle.cli.path, args, {
      cwd: handle.projectPath,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    const forked: SessionHandle = {
      ...handle,
      sessionPath: "",
      sessionId: "",
      child,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      normalizer: new Normalizer(),
      initialized: false,
      pending: new Map(),
      controlWaiters: new Map(),
      streaming: false,
      resumeId: handle.sessionId,
      initModel: null,
      lastUsage: null,
      slashCommands: null,
      dead: false,
      client: null as unknown as SessionClient,
    };
    forked.client = this.makeClient(forked);
    this.attachStdio(forked);

    // **必须发一条消息才会拿到 `system:init`。**
    // 实测：`--resume <id> --fork-session` 单独启动时 CLI 一直沉默，因为 `-p` 模式下
    // init 是在第一条 prompt 时才发的。不发这条，fork 永远拿不到新会话 id，
    // 新 jsonl 也不会落盘（fork 文件是「跑完一轮」才写的）。
    //
    // 这条消息的内容会被记进新会话历史，所以用一句最不打扰的占位语；它也是
    // 用户在新会话里看到的第一条。这是 `--fork-session` 的固有行为，
    // 写在 docs/known-limitations.md 里。
    this.writeLine(forked, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: FORK_OPENER }] },
    });

    await this.waitForInit(forked, 60_000);

    if (forked.sessionId.length === 0) {
      forked.dead = true;
      throw new SessionRegistryError(
        "spawn-failed",
        "fork 之后没有拿到新会话 id（CLI 60s 内没有发 init）",
      );
    }
    this.sessions.set(forked.sessionPath, forked);
    this.touch(forked);
    return forked;
  }

  /** 会话状态快照，形状与 pi 的 `getState()` 一致。 */
  private async stateOf(handle: SessionHandle): Promise<{
    model: { provider: string; id: string } | null;
    thinkingLevel: string;
    isStreaming: boolean;
    isCompacting: boolean;
    sessionFile: string | null;
    sessionId: string;
    sessionName: string | null;
    messageCount: number;
    pendingMessageCount: number;
    autoCompactionEnabled: boolean;
  }> {
    const snapshot = await readSnapshot(handle.sessionPath).catch(() => null);
    return {
      model:
        handle.initModel === null ? null : { provider: "claude", id: handle.initModel },
      // Claude Code 的思考强度是 per-model 的 `effortLevel`，不是会话级 thinkingLevel。
      // 这里报 "off" 表示「不是通过本界面调的」，避免编一个假值。
      thinkingLevel: "off",
      isStreaming: handle.streaming,
      isCompacting: false,
      sessionFile: handle.sessionPath.length > 0 ? handle.sessionPath : null,
      sessionId: handle.sessionId,
      sessionName: null,
      messageCount: snapshot?.messages.length ?? 0,
      pendingMessageCount: 0,
      autoCompactionEnabled: true,
    };
  }

  /** 单写者：一次一行的原子写。 */
  private writeLine(handle: SessionHandle, payload: unknown): void {
    const stdin = handle.child.stdin;
    if (stdin.destroyed || !stdin.writable) {
      throw new SessionRegistryError(
        "no-session",
        "Claude Code 进程的 stdin 已关闭，无法写入",
      );
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private emit(handle: SessionHandle, event: NormalizedEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(handle, event);
      } catch {
        // 一个坏订阅者（通常是断掉的 SSE socket）不能拖垮别人。
      }
    }
  }

  // -------------------------------------------------------------------------
  // 与 routes.ts 对齐的兼容 API
  // -------------------------------------------------------------------------
  //
  // routes.ts 是从 pi-web 整体移植过来的，它围绕 pi 的 `RpcClient` 写了一整套
  // 调用点（`handle.client.prompt(...)`）。为了不动那 1800 行，这里给 handle
  // 挂一个同样形状的 `client` 门面；协议知识仍然只在本目录里。

  /** 打开/接续一个会话。`sessionId` 为 null 表示新建。 */
  async open(projectPath: string, sessionPath?: string | null): Promise<SessionHandle> {
    if (sessionPath !== undefined && sessionPath !== null && sessionPath.length > 0) {
      return await this.resume(sessionPath, projectPath);
    }
    return await this.create(projectPath);
  }

  /**
   * 把一个句柄改登记到另一个键上。
   *
   * 用途：新会话在 `system:init` 之前没有 jar 文件路径，只能用 `draft:<项目>` 当键；
   * 前端订阅的正是这个 draft 键，所以句柄的 `sessionPath` 必须等于它。
   * `system:init` 到达后 `onLine` 会自己把键迁到真 jsonl 路径，那时前端靠
   * `session_init` 事件里的新路径重新订阅。
   */
  alias(handle: SessionHandle, key: string): void {
    // **只登记别名，不改 `handle.sessionPath`。**
    // 改的话，`system:init` 里那句「路径变了要广播改名」会在第二轮 init 时
    // 再次命中（prev=draft、new=jsonl 恰好反过来），前端会收到一次假的改名。
    // 真实路径始终由 `handle.sessionPath` 表示；draft 键只是一张可以查回来的表。
    if (key === handle.sessionPath) return;
    this.sessions.set(key, handle);
    this.aliases.set(key, handle.sessionPath);
  }

  /** 标记句柄已死，下次请求会重开。 */
  markDead(sessionPath: string): void {
    const handle = this.sessions.get(sessionPath);
    if (handle === undefined) return;
    handle.dead = true;
    this.dispose(handle, "marked_dead");
  }

  /** 关掉一个会话。 */
  async close(sessionPath: string, reason = "closed"): Promise<void> {
    this.stop(sessionPath, reason);
  }

  /** 关掉除 `keep` 之外的全部会话。 */
  async closeAllExcept(keep: SessionHandle | null, reason = "closed"): Promise<void> {
    for (const handle of [...this.sessions.values()]) {
      if (handle === keep) continue;
      this.dispose(handle, reason);
    }
  }

  /** 订阅「某个会话已关闭」。 */
  onClosed(listener: (handle: SessionHandle, reason: string) => void): () => void {
    const wrapped: SessionEventListener = (handle, event) => {
      if (event.type !== "session_closed") return;
      listener(handle, String(event.reason ?? "closed"));
    };
    return this.onEvent(wrapped);
  }

  /**
   * 定期扫描空闲进程，作为每个句柄自己的 idle 计时器的兜底。
   * 返回停止函数。
   */
  startSweeper(intervalMs = 60_000): () => void {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const handle of [...this.sessions.values()]) {
        if (handle.pending.size > 0) continue;
        if (handle.streaming) continue;
        if (now - handle.lastActivityAt < this.idleTimeoutMs) continue;
        this.dispose(handle, "idle_timeout");
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 关掉全部（服务退出时）。 */
  async closeAll(reason = "server_shutdown"): Promise<void> {
    await this.closeAllExcept(null, reason);
  }

  /** 找一个属于该项目的活会话。 */
  findLive(projectPath: string): SessionHandle | undefined {
    for (const handle of this.sessions.values()) {
      if (handle.projectPath === projectPath) return handle;
    }
    return undefined;
  }

  /**
   * 预热：为项目起一个进程，让第一次发消息不用等 1–2 秒。
   *
   * 预热出来的会话还没有 `system:init` 的 id，所以它挂在项目路径下的临时键上。
   */
  async prewarm(projectPath: string): Promise<void> {
    if (this.findLive(projectPath) !== undefined) return;
    if (this.activeCount() >= this.maxActiveSessions) return;
    try {
      await this.create(projectPath);
    } catch {
      // 预热失败不是错误：用户发第一条消息时会再试一次并拿到真正的错误。
    }
  }

  /** 预热并返回句柄（拿不到就 null）。 */
  async ensurePrewarmed(projectPath: string): Promise<SessionHandle | null> {
    const existing = this.findLive(projectPath);
    if (existing !== undefined) return existing;
    await this.prewarm(projectPath);
    return this.findLive(projectPath) ?? null;
  }

  /** 认领一个已经预热好的会话（避免重复起进程）。 */
  claimPrewarmed(projectPath: string): SessionHandle | null {
    return this.findLive(projectPath) ?? null;
  }

  /**
   * 列出一个项目可用的斜杠命令。
   *
   * 来源是 `system:init.slash_commands`，但那个只有进程启动后才有。没进程时返回空，
   * 由 `commands.ts` 的内置命令兜底 —— 不硬编码任何一个 CLI 命令名。
   */
  async listCommands(projectPath: string): Promise<SlashCommand[]> {
    const handle = this.findLive(projectPath);
    if (handle === undefined || handle.slashCommands === null) return [];
    return handle.slashCommands.map((name) => ({
      name,
      source: "extension" as const,
    }));
  }
}

export const registry = new SessionRegistry();
