import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MCP 服务器：读 Claude Code 自己的配置，**第一版只读**。
 *
 * 配置来源（按 Claude Code 的实际布局）：
 * - `~/.claude.json` 的 `mcpServers`            —— 用户级（CLI 的主配置）
 * - `<project>/.mcp.json`                        —— 项目级（团队共享）
 * - `~/.claude/settings.json` 的 `mcpServers`   —— 部分版本也认这里
 *
 * 为什么不写入：这些文件的 schema 是 Claude Code 的私有实现细节。用 UI 写进去等于在
 * 一个没有契约的格式上做双写 —— 一旦它的字段改名，我们的写入会静默毁掉用户的配置。
 * 要增删改，去终端里用 `/mcp`，或直接编辑文件。这条取舍写在
 * `docs/known-limitations.md`。
 */

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type McpTransport = "stdio" | "http" | "unknown";

export interface McpServerView {
  name: string;
  transport: McpTransport;
  /** stdio 是命令行，remote 是 URL。 */
  detail: string;
  command: string | null;
  args: string;
  cwd: string | null;
  url: string | null;
  /** 环境变量的**名字**。值永远不离开服务端。 */
  envKeys: string[];
  /** 请求头的**名字**，同样的理由。 */
  headerKeys: string[];
  enabled: boolean;
  /** 这个定义来自哪个文件。 */
  sourcePath: string;
  sourceKind: "user" | "project";
}

export interface McpView {
  projectPath: string | null;
  servers: McpServerView[];
  /** 从配置文件里读到的问题；有错也不影响列表渲染。 */
  errors: string[];
  /** 本页可能读取的每个文件，页脚展示。 */
  paths: {
    /** 用户级定义所在文件。 */
    global: string;
    /** 项目级定义所在文件。空串表示没有工作区。 */
    project: string;
  };
  /** 本版只读。前端据此禁用所有编辑按钮。 */
  readOnly: true;
  error: string | null;
}

function claudeHome(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), ".claude");
}

export function mcpPaths(projectPath: string | null): McpView["paths"] {
  return {
    global: join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), ".claude.json"),
    project:
      projectPath === null || projectPath.length === 0
        ? ""
        : join(projectPath, ".mcp.json"),
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 一个原始条目 → 视图。
 *
 * 字段兼容两种风格：Claude Code 的 `{type, command, args, env}` / `{type, url, headers}`，
 * 以及 MCP 早期配置里省略 `type` 的写法（有 `command` 就是 stdio，有 `url` 就是 http）。
 */
function toServerView(
  name: string,
  entry: unknown,
  sourcePath: string,
  sourceKind: "user" | "project",
): McpServerView | null {
  if (!isRecord(entry)) return null;

  const command = typeof entry.command === "string" ? entry.command : null;
  const url = typeof entry.url === "string" ? entry.url : null;
  const declaredType = typeof entry.type === "string" ? entry.type : null;

  const transport: McpTransport =
    declaredType === "stdio" || (declaredType === null && command !== null)
      ? "stdio"
      : declaredType === "http" || declaredType === "sse" || (declaredType === null && url !== null)
        ? "http"
        : "unknown";

  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === "string")
    : [];

  const envKeys = isRecord(entry.env) ? Object.keys(entry.env) : [];
  const headerKeys = isRecord(entry.headers) ? Object.keys(entry.headers) : [];

  const detail =
    transport === "stdio"
      ? [command ?? "", ...args].join(" ").trim()
      : (url ?? "");

  return {
    name,
    transport,
    detail,
    command,
    args: args.join(" "),
    cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    url,
    // 只报键名。值是 token / API key，不该到前端，更不该进日志。
    envKeys,
    headerKeys,
    enabled: entry.disabled !== true && entry.enabled !== false,
    sourcePath,
    sourceKind,
  };
}

/** 从一份配置对象里抠出 servers，逐条转成视图。 */
function collectServers(
  servers: unknown,
  sourcePath: string,
  sourceKind: "user" | "project",
  errors: string[],
): McpServerView[] {
  if (servers === undefined) return [];
  if (!isRecord(servers)) {
    errors.push(`${sourcePath}：mcpServers 不是对象，已跳过。`);
    return [];
  }
  const out: McpServerView[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const view = toServerView(name, entry, sourcePath, sourceKind);
    if (view === null) {
      errors.push(`${sourcePath}：${name} 的条目形状不认识，已跳过。`);
      continue;
    }
    out.push(view);
  }
  return out;
}

/**
 * 读所有 MCP 服务器。
 *
 * 项目级优先于用户级：同名时项目那份赢，与 Claude Code 自己的覆盖规则一致。
 */
export async function readMcp(projectPath: string | null): Promise<McpView> {
  const paths = mcpPaths(projectPath);
  const errors: string[] = [];
  const byName = new Map<string, McpServerView>();

  // 用户级：`~/.claude.json` 与 `~/.claude/settings.json` 两处都看。
  const userConfig = await readJsonFile(paths.global);
  if (userConfig !== null) {
    for (const server of collectServers(userConfig.mcpServers, paths.global, "user", errors)) {
      byName.set(server.name, server);
    }
  }
  const settingsFile = join(claudeHome(), "settings.json");
  const settings = await readJsonFile(settingsFile);
  if (settings !== null) {
    for (const server of collectServers(settings.mcpServers, settingsFile, "user", errors)) {
      byName.set(server.name, server);
    }
  }

  // 项目级覆盖用户级。
  if (paths.project.length > 0) {
    const projectConfig = await readJsonFile(paths.project);
    if (projectConfig !== null) {
      const servers = isRecord(projectConfig.mcpServers)
        ? projectConfig.mcpServers
        : projectConfig;
      for (const server of collectServers(servers, paths.project, "project", errors)) {
        byName.set(server.name, server);
      }
    }
  }

  const servers = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    projectPath,
    servers,
    errors,
    paths,
    readOnly: true,
    error: null,
  };
}

/** 第一版不支持保存。 */
export async function saveMcpServer(_input: unknown): Promise<McpView> {
  throw new McpConfigError(
    "本版不写入 MCP 配置。请用终端里的 /mcp，或直接编辑 ~/.claude.json / <项目>/.mcp.json。",
  );
}

/** 第一版不支持删除。 */
export async function deleteMcpServer(_input: unknown): Promise<McpView> {
  throw new McpConfigError(
    "本版不写入 MCP 配置。请用终端里的 /mcp，或直接编辑配置文件。",
  );
}

/** 第一版不支持启用/禁用。 */
export async function setMcpServerEnabled(_input: unknown): Promise<McpView> {
  throw new McpConfigError(
    "本版不写入 MCP 配置。请用终端里的 /mcp 切换。",
  );
}

/**
 * 探活一个 MCP 服务器。
 *
 * 第一版不做：真正连一次需要按 transport 起子进程或发 HTTP，等于在本项目里
 * 重新实现一个 MCP 客户端。Claude Code 的 `system:init.mcp_servers` 已经带了
 * 每个服务器的连接状态（`connected` / `pending` / …），用它就够了。
 */
export async function probeMcpServer(_input: unknown): Promise<never> {
  throw new McpConfigError(
    "本版不做 MCP 探活。请查看会话信息里的 mcp_servers 状态（由 Claude Code 报告）。",
  );
}
