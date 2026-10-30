/**
 * Claude Code 的控制平面：`control_request` / `control_response` 的编解码。
 *
 * **协议隔离规则（见 PROJECT_RULES.md）：只有本文件与 `normalize.ts` 允许知道
 * Claude Code 的线上格式。** 路由、存储、前端一律与协议无关。
 *
 * 本文件里的每个字段名都来自实测，不是猜的：
 * 证据是 `claude.exe` 里 bun 打包的那份 JS 中的 zod schema，加上实跑
 * `--input-format stream-json` 的原始输出。改动前先看 PROJECT_RULES.md 第一~十节。
 */
import type { ComposerContext } from "./types.ts";

/** 权限模式六态。`manual` 只是 `default` 的展示别名，不是第七个值。 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** 权限规则的作用域。`userSettings` 写的是 `~/.claude/settings.json`。 */
export type PermissionDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  toolName: string;
  /** 可选的匹配内容，例如 `Bash` 的 `npm test`。 */
  ruleContent?: string;
}

/**
 * 一条持久化的权限变更。
 *
 * 「总是允许」就是一条 `addRules` + `behavior: "allow"` + `destination: "userSettings"` ——
 * 与终端里 Claude Code 自己的 `/permissions` 写入完全一致，也正因如此才不能自己改文件，
 * 必须把它交给 CLI 去写。
 */
export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: PermissionRule[];
      behavior: PermissionBehavior;
      destination: PermissionDestination;
    }
  | { type: "setMode"; mode: PermissionMode; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

/** 用户这一次决定属于哪一档。与 UI 的三个按钮一一对应，别混用。 */
export type DecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

/** CLI → 宿主：请批准一次工具调用。 */
export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  /** 人类可读的工具名，直接用它的，不要自己起名。 */
  display_name?: string;
  /**
   * 工具入参**原样**。UI 必须完整展示，不截断、不美化 —— 用户要看清
   * `Bash` 到底跑什么、`Write` 到底写哪。
   */
  input: Record<string, unknown>;
  tool_use_id: string;
  description?: string;
  /** CLI 建议的持久化规则；「总是允许」应优先采用它建议的粒度。 */
  permission_suggestions?: PermissionUpdate[];
  /** 被已有规则挡住的路径，用于告诉用户「为什么这次还是问了」。 */
  blocked_path?: string;
  /** true 表示必须用户亲自决定，不可自动批准。 */
  requires_user_interaction?: boolean;
  tool_kind?: string;
}

/** 宿主 → CLI：一次批准/拒绝。 */
export interface CanUseToolResponse {
  behavior: "allow" | "deny";
  /** allow 时可改写工具入参。 */
  updatedInput?: Record<string, unknown>;
  /** allow 时可持久化权限变更（「总是允许」走这里）。 */
  updatedPermissions?: PermissionUpdate[];
  /** deny 时回给模型的拒绝原因。 */
  message?: string;
  /** deny 时是否同时中断本轮。 */
  interrupt?: boolean;
  toolUseID?: string;
  decisionClassification?: DecisionClassification;
}

/** CLI 发来的控制消息外壳。 */
export interface ControlRequestEnvelope {
  type: "control_request";
  request_id: string;
  request: { subtype: string; [key: string]: unknown };
}

/** 我们回给 CLI 的控制消息外壳。注意 response 是**嵌套**的，写错过一次。 */
export interface ControlResponseEnvelope {
  type: "control_response";
  response:
    | { subtype: "success"; request_id: string; response: CanUseToolResponse | Record<string, unknown> }
    | { subtype: "error"; request_id: string; error: string };
}

/** 判断一行输入是不是控制请求。 */
export function isControlRequest(value: unknown): value is ControlRequestEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "control_request" &&
    typeof (value as { request_id?: unknown }).request_id === "string"
  );
}

/** 把 `request` 收窄成 `can_use_tool`，其余字段原样保留。 */
export function asCanUseToolRequest(
  envelope: ControlRequestEnvelope,
): CanUseToolRequest | null {
  const request = envelope.request;
  if (request.subtype !== "can_use_tool") return null;
  if (typeof request.tool_name !== "string") return null;
  if (typeof request.tool_use_id !== "string") return null;
  const input = request.input;
  if (typeof input !== "object" || input === null) return null;
  return request as unknown as CanUseToolRequest;
}

/** 包一个成功的控制响应。 */
export function successResponse(
  requestId: string,
  response: CanUseToolResponse | Record<string, unknown>,
): ControlResponseEnvelope {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

/** 包一个失败的控制响应（请求形状不对时用）。 */
export function errorResponse(requestId: string, error: string): ControlResponseEnvelope {
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error },
  };
}

/**
 * 三个 UI 按钮 → 响应体。
 *
 * `allow-once` 与 `always-allow` 的区别**只在** `updatedPermissions` 与
 * `decisionClassification`，别的都一样。这是与 CLI 约定的语义，别自己发明。
 */
export function decideAllowOnce(input: Record<string, unknown>): CanUseToolResponse {
  return { behavior: "allow", updatedInput: input, decisionClassification: "user_temporary" };
}

export function decideAlwaysAllow(
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
  fallbackRule: PermissionRule,
): CanUseToolResponse {
  // CLI 建议了粒度就用它的 —— 它知道这次调用该被抽象成「这条命令」还是「这个工具」。
  // 没建议时退化成「允许这个工具」，仍然写进 userSettings，与终端行为一致。
  const updatedPermissions: PermissionUpdate[] =
    suggestions && suggestions.length > 0
      ? suggestions
      : [
          {
            type: "addRules",
            rules: [fallbackRule],
            behavior: "allow",
            destination: "userSettings",
          },
        ];
  return {
    behavior: "allow",
    updatedInput: input,
    updatedPermissions,
    decisionClassification: "user_permanent",
  };
}

export function decideDeny(input: {
  message?: string;
  interrupt?: boolean;
}): CanUseToolResponse {
  return {
    behavior: "deny",
    message: input.message && input.message.length > 0 ? input.message : "User rejected this action.",
    interrupt: input.interrupt === true,
    decisionClassification: "user_reject",
  };
}

/** 从一次工具调用推导出「总是允许」的兜底规则。 */
export function fallbackRule(request: CanUseToolRequest): PermissionRule {
  const command = request.input.command;
  if (request.tool_name === "Bash" && typeof command === "string" && command.length > 0) {
    return { toolName: "Bash", ruleContent: command };
  }
  return { toolName: request.tool_name };
}

// ---------------------------------------------------------------------------
// 宿主 → CLI 的其它控制命令
// ---------------------------------------------------------------------------

let nextControlRequestId = 1;
export function nextRequestId(prefix = "req"): string {
  return `${prefix}_${Date.now()}_${nextControlRequestId++}`;
}

/** 中断当前轮。 */
export function interruptCommand(requestId = nextRequestId("abort")): Record<string, unknown> {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}

export function setPermissionModeCommand(
  mode: PermissionMode,
  requestId = nextRequestId("perm"),
): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_permission_mode", mode },
  };
}

export function setModelCommand(
  model: string,
  requestId = nextRequestId("model"),
): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_model", model },
  };
}

/** 思考强度档位。 */
export const THINKING_LEVELS = ["auto", "off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** 思考档位对应的 token 预算（null 表示 auto，让上游根据模型默认决定）。 */
export function thinkingTokensForLevel(level: string): number | null {
  switch (level) {
    case "off":
      return 0;
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16384;
    case "max":
      return 32768;
    case "auto":
    default:
      return null;
  }
}

export function setMaxThinkingTokensCommand(
  tokens: number | null,
  requestId = nextRequestId("think"),
): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: tokens },
  };
}

/**
 * 查询当前上下文占用。
 *
 * `detail: "summary"` 返回 `{ totalTokens, maxTokens, rawMaxTokens,
 * percentage, categories }`，与终端 `/context` 同源，使用 CLI 的本地估算，
 * 不发聊天消息。分母直接用 CLI 返回的 `maxTokens`，不猜模型容量，也不假设
 * `rawMaxTokens` 与它必然不同（2.1.309 实现中两者可能相等）。
 *
 * settings.json 通常没有窗口字段，jsonl 也不记它，而 result 的模型窗口
 * 可能为空，所以优先使用这条控制查询。
 */
export function getContextUsageCommand(
  detail: "summary" | "full" = "summary",
  requestId = nextRequestId("ctx"),
): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "get_context_usage", detail },
  };
}

/** 控制回执里的上下文摘要 → 前端契约，错误或缺失字段不伪装成 0。 */
export function contextUsageFromResponse(payload: Record<string, unknown>): ComposerContext | null {
  if (payload.subtype !== "success") return null;
  const raw = payload.response;
  if (typeof raw !== "object" || raw === null) return null;
  const { totalTokens, maxTokens } = raw as Record<string, unknown>;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) return null;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) return null;
  return {
    tokens: totalTokens,
    contextWindow: maxTokens,
    percent: (totalTokens / maxTokens) * 100,
    source: "live",
  };
}

/** 取消一个我们已经发出、但已不需要结果的请求（例如组件卸载）。 */
export function cancelRequestCommand(requestId: string): Record<string, unknown> {
  return { type: "control_cancel_request", request_id: requestId };
}
