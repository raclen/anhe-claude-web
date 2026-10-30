/**
 * 内置的 MCP 权限中继。
 *
 * **它解决的正是「没有权限询问窗口」这件事。**
 *
 * 实测 Claude Code CLI 2.1.309（PROJECT_RULES.md 第 11 节）：`--permission-prompt-tool`
 * 接受一个 `mcp__<服务器名>__<工具名>` 形式的工具名。CLI 需要授权时**调用这个 MCP 工具**，
 * 把返回的 JSON 文本当作裁决（`{behavior:"allow", updatedInput}` / `{behavior:"deny", message}`，
 * 「总是允许」再带上 `updatedPermissions`）。所以权限卡不再需要伪造 SDK 宿主、更不需要
 * `--dangerously-skip-permissions`。
 *
 * **形态选择：HTTP 型 MCP，复用本服务自己的端口。**
 * 备选是 stdio —— 那要额外起一个 node 子进程，还得往发布包里塞一个入口脚本；
 * HTTP 没有这些成本，端点就是本进程的一个路由，CLI 从 loopback 连过来即可。
 * URL 带上每次 spawn 随机生成的 relay id：它既是「这次调用属于哪个会话」的地址，
 * 也是唯一的凭据（不进 argv、不落日志）。
 *
 * 本文件与 `agent/controls.ts` 的分工：这里只管 MCP/JSON-RPC 的**信封**，
 * 裁决体（`behavior` / `updatedPermissions` 的语义）全部由 `controls.ts` 给出。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionUpdate } from "./agent/controls.ts";

/** MCP 配置里这台服务器的名字。工具全名由它和工具名拼出，改名会打断 `--permission-prompt-tool`。 */
export const PERMISSION_SERVER_NAME = "anhe-permission";

/** 中继唯一暴露的工具名。 */
export const PERMISSION_TOOL_NAME = "ask";

/** 传给 CLI 的完整工具名。 */
export const PERMISSION_PROMPT_TOOL = `mcp__${PERMISSION_SERVER_NAME}__${PERMISSION_TOOL_NAME}`;

/** 本服务上承载这个 MCP 端点的路径。 */
export const PERMISSION_MCP_PATH = "/api/mcp/permission";

/** 查询参数名：这次调用属于哪个 relay。 */
export const RELAY_QUERY_KEY = "relay";

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** CLI 调 `ask` 时给的参数，收窄后的形状。 */
export interface AskArguments {
  toolName: string;
  /** 工具入参**原样**，不裁剪 —— SECURITY.md 硬边界 3。 */
  input: Record<string, unknown>;
  toolUseId: string;
  description: string | null;
  blockedPath: string | null;
  /** CLI 建议的持久化规则；「总是允许」优先采用它建议的粒度。 */
  suggestions: PermissionUpdate[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 收窄一次 `ask` 调用。
 *
 * 缺 `tool_name` 或 `input` 就返回 null —— 那种请求我们无法如实展示给用户，
 * 与其猜不如让调用方回一个明确的拒绝。
 */
export function parseAskArguments(raw: unknown): AskArguments | null {
  if (!isRecord(raw)) return null;
  const toolName = raw.tool_name;
  const input = raw.input;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  if (!isRecord(input)) return null;
  const suggestions = Array.isArray(raw.permission_suggestions)
    ? (raw.permission_suggestions as PermissionUpdate[])
    : undefined;
  return {
    toolName,
    input,
    toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : "",
    description: typeof raw.description === "string" && raw.description.length > 0 ? raw.description : null,
    blockedPath: typeof raw.blocked_path === "string" && raw.blocked_path.length > 0 ? raw.blocked_path : null,
    suggestions,
  };
}

/** 一次 `ask` 调用 → 交给 CLI 的 MCP 工具结果。 */
export function toolResult(body: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

/** 这台服务器对外公布的唯一工具。 */
const ASK_TOOL = {
  name: PERMISSION_TOOL_NAME,
  description:
    "Ask the human whether a tool call may run. Returns the decision as JSON: " +
    '{"behavior":"allow","updatedInput":…} or {"behavior":"deny","message":…}.',
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
      description: { type: "string" },
      blocked_path: { type: "string" },
      permission_suggestions: { type: "array" },
    },
    required: ["tool_name", "input"],
  },
} as const;

/** 一条 JSON-RPC 消息的应答。`accepted` 表示通知，回 202 空体。 */
export type McpReply =
  | { kind: "accepted" }
  | { kind: "result"; body: Record<string, unknown> };

/**
 * 处理一条 MCP 消息。
 *
 * `ask(args)` 由调用方提供：它负责把请求交给界面、并等到用户做出决定。
 * 这里只做信封转换，不认识的方法一律回空结果 —— 目的是让握手能走完，
 * 而不是让 CLI 卡在一个它没指望我们实现的方法上。
 */
export async function handlePermissionMcpMessage(
  message: unknown,
  ask: (args: AskArguments) => Promise<Record<string, unknown>>,
): Promise<McpReply> {
  if (!isRecord(message)) return { kind: "accepted" };
  const id = message.id;
  // 没有 id 的是通知（`notifications/initialized` 等），按 MCP 规范回 202。
  if (id === undefined || id === null) return { kind: "accepted" };
  const method = typeof message.method === "string" ? message.method : "";
  const params = isRecord(message.params) ? message.params : {};

  const ok = (result: Record<string, unknown>): McpReply => ({
    kind: "result",
    body: { jsonrpc: "2.0", id, result },
  });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: PERMISSION_SERVER_NAME, version: "1.0.0" },
      });
    case "tools/list":
      return ok({ tools: [ASK_TOOL] });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name !== PERMISSION_TOOL_NAME) {
        return ok({ isError: true, content: [{ type: "text", text: `unsupported tool: ${name}` }] });
      }
      const args = parseAskArguments(params.arguments);
      if (args === null) {
        // 形状不认识时不猜：回一条拒绝，让 CLI 走它的默认路径。
        return ok(
          toolResult({ behavior: "deny", message: "anhe-claude-web 收到的权限请求缺少工具名或入参。" }),
        );
      }
      return ok(toolResult(await ask(args)));
    }
    default:
      return ok({});
  }
}

/**
 * 这次 spawn 用的 MCP 配置文件。
 *
 * 为什么不把 JSON 直接写在 `--mcp-config` 后面：实测内联字符串会被判
 * 「Invalid MCP configuration」，只有**文件路径**被接受。
 */
export function mcpConfigFor(relayId: string, port: number): Record<string, unknown> {
  const url = `http://127.0.0.1:${port}${PERMISSION_MCP_PATH}?${RELAY_QUERY_KEY}=${encodeURIComponent(relayId)}`;
  return { mcpServers: { [PERMISSION_SERVER_NAME]: { type: "http", url } } };
}

/** 把配置写进一个只有本次会话会读的临时文件，返回路径。 */
export function writeMcpConfig(relayId: string, port: number): string {
  const dir = join(tmpdir(), "anhe-claude-web-permission");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `mcp-${relayId}.json`);
  writeFileSync(path, JSON.stringify(mcpConfigFor(relayId, port), null, 2), "utf8");
  return path;
}

/** 删掉临时配置文件。会话收尾时必须调，否则每个会话都会在临时目录留一份。 */
export function removeMcpConfig(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 删不掉不是错误：临时目录本就由系统回收。
  }
}