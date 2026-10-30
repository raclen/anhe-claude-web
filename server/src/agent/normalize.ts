/**
 * 把 Claude Code 的 `--output-format stream-json` 输出归一成前端已经消费的事件形状。
 *
 * **协议隔离规则（见 PROJECT_RULES.md）：只有本文件与 `controls.ts` 允许知道
 * Claude Code 的线上格式。**
 *
 * 归一化的目标形状取自 pi-web 的既有契约（`web/src/lib/types.ts` 的
 * `AssistantStreamEvent` 与 `SessionEvent`），这样 `streaming-json.ts`、
 * `row-model.ts`、`turn-rail.ts` 一行都不用改：
 *
 *   agent_start        一轮开始
 *   message_start      一条 assistant 消息开始（前端据此清空拼装槽）
 *   message_update     增量（text/thinking/toolcall 的 *_start/_delta/_end）
 *   message_end        一条消息定稿
 *   tool_execution_*   工具调用的开始/结束（由 tool_use / tool_result 推导）
 *   agent_settled      一轮结束
 *
 * 两条路都要能跑：
 *   1. 有 `stream_event`（需 `--include-partial-messages`）→ 真增量，打字机效果
 *   2. 没有 `stream_event`（上游不转发 SSE）→ 退回整条 `assistant` 一次性定稿
 * 第 2 条不是降级容错，是必须有的路径：实测有上游完全不发增量。
 */
import type { ContentBlock, Usage } from "./types.ts";
import type { PermissionUpdate } from "./controls.ts";

/** 前端消费的一条归一化事件。`type` 与 pi-web 的 `SessionEvent` 对齐。 */
export interface NormalizedEvent {
  type: string;
  [key: string]: unknown;
}

/** Claude Code 的 usage → 前端的 `Usage`。字段名不同，别混。 */
function toUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" ? value : 0;
  };
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite: num("cache_creation_input_tokens"),
  };
}

/** 把 Anthropic 的 content block 转成前端能渲染的 `ContentBlock`。 */
function toContentBlock(block: unknown): ContentBlock | null {
  if (typeof block !== "object" || block === null) return null;
  const raw = block as Record<string, unknown>;
  switch (raw.type) {
    case "text":
      return { type: "text", text: typeof raw.text === "string" ? raw.text : "" };
    case "thinking":
      return { type: "thinking", thinking: typeof raw.thinking === "string" ? raw.thinking : "" };
    case "tool_use":
      return {
        type: "toolCall",
        id: typeof raw.id === "string" ? raw.id : "",
        name: typeof raw.name === "string" ? raw.name : "",
        arguments:
          typeof raw.input === "object" && raw.input !== null
            ? (raw.input as Record<string, unknown>)
            : {},
      };
    default:
      return null;
  }
}

/**
 * `structuredPatch` 的一个 hunk —— Claude Code 的 Edit / Write 结果里就有它。
 *
 * `lines` 与 unified diff 的正文同形：首个字符是 ` ` / `+` / `-`。这正是为什么
 * 下面拼 patch 时不需要再理解内容，只需要补一行 `@@` 头。
 */
interface StructuredHunk {
  oldStart?: unknown;
  oldLines?: unknown;
  newStart?: unknown;
  newLines?: unknown;
  lines?: unknown;
}

/**
 * 一个 `structuredPatch` 数组 → unified diff 文本。
 *
 * 存在的理由：前端的改动卡片只认 `details.patch`（见 `turn-files.patchOf`），而
 * Claude Code 给的是结构化 hunk，不是 patch 文本。转换放在这里而不是前端，是因为
 * 这是**协议形状**的知识 —— 按 PROJECT_RULES 的组织约定，它只该出现在本文件。
 *
 * 实测（CLI 2.1.309）两个入口的字段名不同，但 `structuredPatch` 本身一致：
 * - 实时流 `stream-json`：顶层 `tool_use_result`（snake_case）
 * - 历史 jsonl：顶层 `toolUseResult`（camelCase）
 *
 * 返回 null 表示「没有可用的 patch」：不携带、不是数组、或者一个 hunk 都没有。
 * 调用方据此保持 `details` 原样，而不是塞一个空 patch 让计数变成 0。
 */
function patchFromStructured(structured: unknown): string | null {
  if (!Array.isArray(structured) || structured.length === 0) return null;
  const hunks: string[] = [];
  for (const item of structured) {
    if (typeof item !== "object" || item === null) continue;
    const hunk = item as StructuredHunk;
    if (!Array.isArray(hunk.lines)) continue;
    // `@@ -1,3 +1,3 @@`：缺省字段按 unified diff 的默认值补 1 / 0，避免拼出 `NaN`。
    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : 0;
    const body = hunk.lines.filter((line): line is string => typeof line === "string");
    hunks.push(`@@ -${String(oldStart)},${String(oldLines)} +${String(newStart)},${String(newLines)} @@`);
    hunks.push(...body);
  }
  return hunks.length === 0 ? null : hunks.join("\n");
}

/**
 * 工具结果里那份「工具自己的细节」→ 前端 `ToolResultMessage.details`。
 *
 * 前端只认一个字段：`details.patch`。除此之外原样透传，因为别的工具视图
 * （待办清单读 `details.todos` / `details.tasks`）也走这条路。
 *
 * 原样透传是安全的：`parseTodoSnapshot` 只认数组字段，多一个 `structuredPatch`
 * 不会让它误判；而 `turn-files.patchOf` 只认字符串 `patch`。
 */
function toToolDetails(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const details = raw as Record<string, unknown>;
  const patch = patchFromStructured(details.structuredPatch);
  // 没有 patch 时返回原对象而不是 `{...details, patch: undefined}`，免得前端
  // `details.patch` 存在但为 undefined 时被误当成「有 patch」。
  return patch === null ? details : { ...details, patch };
}

/** 一个正在拼装的 content block。 */
interface BlockSlot {
  kind: "text" | "thinking" | "toolcall" | "other";
  /** tool_use 的 id 与 name，在 content_block_start 时就有。 */
  toolId?: string;
  toolName?: string;
  /** tool_use 的入参 JSON 是分片到的，必须自己拼。 */
  rawArgs: string;
  text: string;
  thinking: string;
}

/**
 * 一个流的归一化器。
 *
 * 每个 `claude` 子进程配一个实例，因为块索引（`content_block_delta.index`）
 * 与消息 id 都是这个进程内自洽的。
 */
export class Normalizer {
  /** 当前消息是否收到过 `stream_event` 增量。用来避免 assistant 重复定稿。 */
  private sawStreamEvents = false;
  /** 当前消息的拼装槽，按 content block index 索引。 */
  private slots = new Map<number, BlockSlot>();
  /** 已经发出 `agent_start` 但还没 `agent_settled`。 */
  private streaming = false;
  /** 已经发过 tool_execution_start 的调用 id，避免重复发。 */
  private startedTools = new Set<string>();
  /** 当前是否有一条 assistant 消息正在拼装（已发 message_start、未发 message_end）。 */
  private messageOpen = false;
  /** 是否处于 API 重试退避中。 */
  private inRetry = false;
  private retryAttempt = 0;

  /** 喂一行解析好的对象，拿回要推给前端的归一化事件。 */
  push(raw: unknown): NormalizedEvent[] {
    if (typeof raw !== "object" || raw === null) return [];
    const event = raw as Record<string, unknown>;
    const type = event.type;

    switch (type) {
      case "system":
        return this.onSystem(event);
      case "stream_event":
        return this.onStreamEvent(event);
      case "assistant":
        return this.onAssistant(event);
      case "user":
        return this.onUser(event);
      case "result":
        return this.onResult(event);
      case "control_request":
      case "control_response":
        // 控制平面由 registry/controls 处理，不进消息流。registry 在把事件交给
        // 这里之前已经拦掉了它们；这一支只是防御。
        return [];
      default:
        return [];
    }
  }

  private onSystem(event: Record<string, unknown>): NormalizedEvent[] {
    const subtype = event.subtype;
    if (subtype === "init") {
      return [
        {
          type: "session_init",
          sessionId: event.session_id,
          model: event.model,
          permissionMode: event.permissionMode,
          tools: event.tools,
          mcpServers: event.mcp_servers,
          slashCommands: event.slash_commands,
          terminalSlashCommands: event.terminal_slash_commands,
          claudeCodeVersion: event.claude_code_version,
          outputStyle: event.output_style,
          agents: event.agents,
          skills: event.skills,
          plugins: event.plugins,
          capabilities: event.capabilities,
          memoryPaths: event.memory_paths,
          cwd: event.cwd,
        },
      ];
    }
    if (subtype === "permission_denied") {
      // Claude Code 自己拒绝了这次工具调用。**这不是我们能替用户批准的场合** ——
      // 见 FINDINGS.md 第 11 节：这个版本的 CLI 不把权限提问交给本进程。
      // 所以如实把它渲染成一条拒绝说明，并带上原始原因，让用户知道去改什么。
      return [
        {
          type: "permission_denied",
          toolName: event.tool_name ?? null,
          toolUseId: event.tool_use_id ?? null,
          message: typeof event.message === "string" ? event.message : null,
          decisionReasonType: event.decision_reason_type ?? null,
        },
      ];
    }
    if (subtype === "compact_boundary") {
      return [{ type: "compaction", summary: event.summary ?? null }];
    }
    if (subtype === "api_retry") {
      this.inRetry = true;
      this.retryAttempt = typeof event.attempt === "number" ? event.attempt : 1;
      // 上游在退避重试。前端已有 `auto_retry_start` 的处理，复用它能立刻显示倒计时。
      return [
        {
          type: "auto_retry_start",
          attempt: this.retryAttempt,
          maxAttempts: event.max_retries,
          delayMs: typeof event.retry_delay_ms === "number" ? event.retry_delay_ms : 0,
          errorMessage: event.error ?? "",
        },
      ];
    }
    // `status` / `hook_*` 等不进对话流。
    return [];
  }

  private onStreamEvent(event: Record<string, unknown>): NormalizedEvent[] {
    const inner = event.event;
    if (typeof inner !== "object" || inner === null) return [];
    const sse = inner as Record<string, unknown>;
    const out: NormalizedEvent[] = [];

    switch (sse.type) {
      case "message_start": {
        if (this.inRetry) {
          this.inRetry = false;
          out.push({
            type: "auto_retry_end",
            attempt: this.retryAttempt,
            success: true,
          });
        }
        this.sawStreamEvents = true;
        this.slots.clear();
        this.beginStream(out);
        this.messageOpen = true;
        out.push({
          type: "message_start",
          message: { role: "assistant", content: [], timestamp: Date.now() },
        });
        break;
      }
      case "content_block_start": {
        const index = this.index(sse.index);
        if (index === null) break;
        // 一轮里可能有连续的 assistant 消息（思考 → 文本 → 工具）。上游偶尔会省掉
        // 后续消息的 `message_start`；前端需要一个「开始新槽」的信号，否则新块会
        // 被拼到上一条已定稿的消息上。
        this.ensureMessageOpen(out);
        const block = sse.content_block as Record<string, unknown> | undefined;
        const kind = block?.type;
        if (kind === "text") {
          this.slots.set(index, { kind: "text", rawArgs: "", text: "", thinking: "" });
          out.push({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: index } });
        } else if (kind === "thinking" || kind === "redacted_thinking") {
          this.slots.set(index, { kind: "thinking", rawArgs: "", text: "", thinking: "" });
          out.push({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_start", contentIndex: index },
          });
        } else if (kind === "tool_use") {
          const toolId = typeof block?.id === "string" ? block.id : "";
          const toolName = typeof block?.name === "string" ? block.name : "";
          this.slots.set(index, {
            kind: "toolcall",
            toolId,
            toolName,
            rawArgs: "",
            text: "",
            thinking: "",
          });
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_start",
              contentIndex: index,
              id: toolId,
              toolName,
            },
          });
        } else {
          this.slots.set(index, { kind: "other", rawArgs: "", text: "", thinking: "" });
        }
        break;
      }
      case "content_block_delta": {
        const index = this.index(sse.index);
        if (index === null) break;
        const slot = this.slots.get(index);
        if (!slot) break;
        const delta = sse.delta as Record<string, unknown> | undefined;
        const deltaType = delta?.type;
        if (deltaType === "text_delta" && typeof delta?.text === "string") {
          slot.text += delta.text;
          out.push({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: delta.text },
          });
        } else if (deltaType === "thinking_delta" && typeof delta?.thinking === "string") {
          slot.thinking += delta.thinking;
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: index,
              delta: delta.thinking,
            },
          });
        } else if (deltaType === "input_json_delta" && typeof delta?.partial_json === "string") {
          slot.rawArgs += delta.partial_json;
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_delta",
              contentIndex: index,
              delta: delta.partial_json,
            },
          });
        }
        // signature_delta / citations_delta 对 UI 无用，丢弃。
        break;
      }
      case "content_block_stop": {
        const index = this.index(sse.index);
        if (index === null) break;
        const slot = this.slots.get(index);
        if (!slot) break;
        if (slot.kind === "text") {
          out.push({
            type: "message_update",
            assistantMessageEvent: { type: "text_end", contentIndex: index, content: slot.text },
          });
        } else if (slot.kind === "thinking") {
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: index,
              content: slot.thinking,
            },
          });
        } else if (slot.kind === "toolcall") {
          const args = this.parseArgs(slot.rawArgs);
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_end",
              contentIndex: index,
              toolCall: {
                type: "toolCall",
                id: slot.toolId ?? "",
                name: slot.toolName ?? "",
                arguments: args,
              },
            },
          });
          out.push(...this.toolStart(slot.toolId ?? "", slot.toolName ?? "", args));
        }
        break;
      }
      case "message_stop":
        // 定稿交给随后的 `assistant` 事件：它带完整的 usage 与 stop_reason。
        break;
      default:
        break;
    }
    return out;
  }

  private onAssistant(event: Record<string, unknown>): NormalizedEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const out: NormalizedEvent[] = [];
    const blocks = Array.isArray(message.content) ? message.content : [];
    const converted: ContentBlock[] = [];
    for (const block of blocks) {
      const mapped = toContentBlock(block);
      if (mapped) converted.push(mapped);
    }

    this.beginStream(out);
    if (this.inRetry) {
      this.inRetry = false;
      out.push({
        type: "auto_retry_end",
        attempt: this.retryAttempt,
        success: true,
      });
    }
    // 只有「整条消息一次性到达」时才补 `message_start`。
    // 用 `messageOpen` 而不是 `sawStreamEvents` 判断：后者在上一条消息定稿时就被
    // 重置了，于是同一条已经通过增量走完的消息会被再补一个空槽 —— 前端就会看到
    // 一个永远不关闭的 `message_start`。
    if (!this.messageOpen) {
      this.messageOpen = true;
      out.push({
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
    }

    // tool_use 块可能没走过 content_block_stop（无增量路径），这里补齐。
    for (const block of converted) {
      if (block.type === "toolCall") {
        const call = block as { id: string; name: string; arguments?: Record<string, unknown> };
        out.push(...this.toolStart(call.id, call.name, call.arguments ?? {}));
        if (!this.sawStreamEvents) {
          out.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_end",
              contentIndex: converted.indexOf(block),
              toolCall: block as never,
            },
          });
        }
      }
    }

    out.push({
      type: "message_end",
      message: {
        role: "assistant",
        content: converted,
        model: message.model,
        stopReason: message.stop_reason,
        usage: toUsage(message.usage),
        timestamp: this.timestamp(event),
        errorMessage:
          event.is_api_error_message === true && typeof (event as { error?: unknown }).error === "string"
            ? String((event as { error?: unknown }).error)
            : undefined,
      },
    });

    this.slots.clear();
    this.sawStreamEvents = false;
    this.messageOpen = false;
    return out;
  }

  private onUser(event: Record<string, unknown>): NormalizedEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = Array.isArray(message.content) ? message.content : [];
    const out: NormalizedEvent[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const raw = block as Record<string, unknown>;
      if (raw.type !== "tool_result") continue;
      const toolCallId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
      const parts = Array.isArray(raw.content) ? raw.content : [];
      const resultContent: ContentBlock[] = [];
      for (const part of parts) {
        const mapped = toContentBlock(part);
        if (mapped) resultContent.push(mapped);
      }
      if (resultContent.length === 0 && typeof raw.content === "string") {
        resultContent.push({ type: "text", text: raw.content });
      }
      out.push({
        type: "tool_execution_end",
        toolCallId,
        // 实时流把工具细节放在事件**顶层**、snake_case 的 `tool_use_result`，
        // 与历史 jsonl 的 camelCase `toolUseResult` 不是同一个名字（实测 CLI
        // 2.1.309）。两个都认，是因为这里同时服务实时流与回放。
        result: { content: resultContent, details: toToolDetails(event["tool_use_result"]) },
        isError: raw.is_error === true,
      });
    }
    return out;
  }

  private onResult(event: Record<string, unknown>): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    if (this.inRetry) {
      this.inRetry = false;
      out.push({
        type: "auto_retry_end",
        attempt: this.retryAttempt,
        success: event.is_error !== true,
      });
    }
    out.push({
      type: "turn_result",
      subtype: event.subtype,
      isError: event.is_error === true,
      durationMs: event.duration_ms,
      durationApiMs: event.duration_api_ms,
      numTurns: event.num_turns,
      totalCostUsd: event.total_cost_usd,
      usage: toUsage(event.usage),
      modelUsage: event.model_usage_since_last_result ?? event.modelUsage ?? {},
      stopReason: event.stop_reason,
      permissionDenials: event.permission_denials ?? [],
      subagentStats: event.subagent_stats ?? null,
      result: typeof event.result === "string" ? event.result : null,
      queuedTurnCount: event.queued_turn_count ?? 0,
    });
    this.streaming = false;
    this.startedTools.clear();
    out.push({ type: "agent_settled" });
    return out;
  }

  /**
   * 一次 `can_use_tool` 请求 → 前端要渲染的权限卡。
   *
   * 入参**原样**传下去，不裁剪 —— 见 SECURITY.md 第 3 条硬边界。
   */
  permissionRequest(
    requestId: string,
    request: {
      tool_name: string;
      display_name?: string;
      input: Record<string, unknown>;
      tool_use_id: string;
      description?: string;
      permission_suggestions?: PermissionUpdate[];
      blocked_path?: string;
      requires_user_interaction?: boolean;
      tool_kind?: string;
    },
  ): NormalizedEvent {
    return {
      type: "permission_request",
      requestId,
      toolName: request.tool_name,
      displayName: request.display_name ?? request.tool_name,
      input: request.input,
      toolUseId: request.tool_use_id,
      description: request.description ?? null,
      suggestions: request.permission_suggestions ?? null,
      blockedPath: request.blocked_path ?? null,
      requiresUserInteraction: request.requires_user_interaction === true,
      toolKind: request.tool_kind ?? null,
    };
  }

  /** 权限卡被回答后，前端要把卡收起来。 */
  permissionResolved(requestId: string, behavior: "allow" | "deny"): NormalizedEvent {
    return { type: "permission_resolved", requestId, behavior };
  }

  /** 进程退出时收尾，避免前端永远停在 streaming。 */
  finalize(reason: string): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    if (this.inRetry) {
      this.inRetry = false;
      out.push({
        type: "auto_retry_end",
        attempt: this.retryAttempt,
        success: false,
      });
    }
    if (!this.streaming) return out;
    this.streaming = false;
    this.slots.clear();
    this.sawStreamEvents = false;
    this.messageOpen = false;
    out.push({ type: "agent_settled", reason });
    return out;
  }

  // -- 内部工具 ------------------------------------------------------------

  /**
   * 标记「本轮已经由外层宣告开始」。
   *
   * `registry.send()` 在写 stdin 之前就发 `agent_start`（前端要立刻锁输入框），
   * 所以 Normalizer 不能再发一遍 —— 否则一次发送会出现两条 `agent_start`，
   * 前端的计时器会被重置一次。
   */
  markStreamStarted(): void {
    this.streaming = true;
  }

  /** 需要时补一条 `message_start`，让前端开一个新拼装槽。 */
  private ensureMessageOpen(out: NormalizedEvent[]): void {
    if (this.messageOpen) return;
    this.messageOpen = true;
    out.push({
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: Date.now() },
    });
  }

  private beginStream(_out: NormalizedEvent[]): void {
    // 只记账，不发事件：`agent_start` 由 registry 在发送时统一发一次。
    this.streaming = true;
  }

  private toolStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): NormalizedEvent[] {
    if (toolCallId.length === 0 || this.startedTools.has(toolCallId)) return [];
    this.startedTools.add(toolCallId);
    return [{ type: "tool_execution_start", toolCallId, toolName, args }];
  }

  private parseArgs(raw: string): Record<string, unknown> {
    if (raw.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // 分片拼出来的 JSON 可能在异常收尾时是残缺的。原样放进去，让工具卡显示它，
      // 比丢掉整条调用好。
      return { __raw: raw };
    }
  }

  private index(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }

  private timestamp(event: Record<string, unknown>): number {
    const raw = event.timestamp;
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now();
  }
}
