import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SESSION_DIR_OVERRIDE, TITLE_FALLBACK_WORDS, TITLE_MAX_BYTES } from "../config.ts";
import { getSessionOverrides } from "../projects.ts";
import { clipPreview, clipTitle, fallbackTitle } from "../title-text.ts";

export type TitleSource =
  | "customTitle"
  | "aiTitle"
  | "summary"
  | "firstMessage"
  | "lastPrompt"
  | "fallback";

export interface SessionView {
  /** 会话 jsonl 的绝对路径。也是会话的身份。 */
  path: string;
  id: string;
  /** 会话所属项目目录。取自 jsonl 行内 `cwd`，绝不从目录名反推。 */
  cwd: string;
  title: string;
  titleSource: TitleSource;
  /** 首条 user 消息，压平并截断；没有则为空串。 */
  preview: string;
  created: string;
  modified: string;
  messageCount: number;
  /** 是否含子代理（`isSidechain: true`）条目。 */
  hasSidechain: boolean;
  hidden: boolean;
  gitBranch?: string;
}

const PREVIEW_MAX_CHARACTERS = 200;

/**
 * Claude Code 的会话根目录。
 *
 * 默认 `~/.claude/projects`；`ANHE_CLAUDE_WEB_SESSION_DIR` 可覆盖（验收脚本用它
 * 隔离用户真实的会话历史）。
 */
export function getSessionRoot(): string {
  return SESSION_DIR_OVERRIDE
    ? resolve(SESSION_DIR_OVERRIDE)
    : join(homedir(), ".claude", "projects");
}

/** 一行 jsonl 的解析结果里我们关心的部分。 */
interface ParsedLine {
  type?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  text?: string;
  summary?: string;
  lastPrompt?: string;
  aiTitle?: string;
  customTitle?: string;
  gitBranch?: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const raw = part as Record<string, unknown>;
    // 只取纯文本。tool_result / image / thinking 都不是用户在「说」什么。
    if (raw.type === "text" && typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n");
}

/**
 * 去掉 IDE 注入的上下文块。
 *
 * Claude Code 从 VS Code 发起的会话会把选区、打开的文件塞进首条消息（
 * `<ide_selection>…</ide_selection>`、`<ide_opened_file>`）。这些不是用户写的话，
 * 拿来当标题会得到一个文件路径。
 */
function stripInjectedContext(text: string): string {
  return text
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, " ")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, " ")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, " ")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, " ")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, " ")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, " ")
    .replace(/<command>[\s\S]*?<\/command>/g, " ")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, " ")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, " ")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<system-err>[\s\S]*?<\/system-err>/g, " ")
    .replace(/<system-out>[\s\S]*?<\/system-out>/g, " ")
    .trim();
}

/** `/skill:name` 折叠：pi-web 的既有逻辑，Claude Code 的 skill 块形状不同但意图相同。 */
function foldSkillCommand(text: string): string {
  const block = /^<skill name="([^"]+)"[\s\S]*?<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (!block) return text;
  const args = block[2]?.trim();
  return args ? `/skill:${block[1]} ${args}` : `/skill:${block[1]}`;
}

async function parseFile(path: string): Promise<{
  cwd: string | null;
  id: string;
  firstUserText: string;
  lastPrompt: string;
  summary: string;
  aiTitle: string;
  customTitle: string;
  gitBranch: string;
  messageCount: number;
  hasSidechain: boolean;
  created: string | null;
  modified: string | null;
}> {
  const result = {
    cwd: null as string | null,
    id: "",
    firstUserText: "",
    lastPrompt: "",
    summary: "",
    aiTitle: "",
    customTitle: "",
    gitBranch: "",
    messageCount: 0,
    hasSidechain: false,
    created: null as string | null,
    modified: null as string | null,
  };

  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let raw: ParsedLine & { message?: { role?: string; content?: unknown } };
      try {
        raw = JSON.parse(trimmed) as typeof raw;
      } catch {
        // 半行（进程被杀时）或格式变化。跳过，不让一个坏行废掉整个会话。
        continue;
      }

      // `cwd` 出现在多数行上；第一个拿到的就是权威的项目路径。
      if (result.cwd === null && typeof raw.cwd === "string" && raw.cwd.length > 0) {
        result.cwd = raw.cwd;
      }
      if (result.id.length === 0 && typeof raw.sessionId === "string") {
        result.id = raw.sessionId;
      }
      if (raw.isSidechain === true) result.hasSidechain = true;
      if (typeof raw.gitBranch === "string" && raw.gitBranch.length > 0 && result.gitBranch.length === 0) {
        result.gitBranch = raw.gitBranch;
      }
      if (typeof raw.aiTitle === "string" && raw.aiTitle.trim().length > 0) {
        result.aiTitle = raw.aiTitle.trim();
      }
      if (typeof raw.customTitle === "string" && raw.customTitle.trim().length > 0) {
        result.customTitle = raw.customTitle.trim();
      }

      if (typeof raw.timestamp === "string") {
        if (result.created === null) result.created = raw.timestamp;
        result.modified = raw.timestamp;
      }

      switch (raw.type) {
        case "ai-title":
          if (typeof raw.aiTitle === "string" && raw.aiTitle.trim().length > 0) {
            result.aiTitle = raw.aiTitle.trim();
          }
          break;
        case "custom-title":
          if (typeof raw.customTitle === "string" && raw.customTitle.trim().length > 0) {
            result.customTitle = raw.customTitle.trim();
          }
          break;
        case "summary":
          if (typeof raw.summary === "string" && result.summary.length === 0) {
            result.summary = raw.summary;
          }
          break;
        case "last-prompt":
          if (typeof raw.lastPrompt === "string") result.lastPrompt = raw.lastPrompt;
          break;
        case "user": {
          if (raw.isSidechain === true) break;
          // 只数真实的人类轮次：工具结果也是 `type: "user"`，但它们不是对话。
          const content = raw.message?.content;
          const isToolResult =
            Array.isArray(content) &&
            content.some(
              (part) =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "tool_result",
            );
          if (isToolResult) break;
          const text = stripInjectedContext(textFromContent(content));
          if (text.length === 0) break;
          result.messageCount += 1;
          if (result.firstUserText.length === 0) result.firstUserText = text;
          break;
        }
        case "assistant":
          if (raw.isSidechain !== true) result.messageCount += 1;
          break;
        default:
          break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return result;
}

/**
 * 标题优先级（与 Claude Code VS Code 扩展规范完全对齐）：
 * customTitle (用户重命名) → aiTitle (AI 智能生成标题) → lastPrompt (最新提问) → summary → 首条 user 消息 → 兜底。
 */
function deriveTitle(parsed: {
  id: string;
  firstUserText: string;
  lastPrompt: string;
  summary: string;
  aiTitle?: string;
  customTitle?: string;
}): { title: string; titleSource: TitleSource } {
  const custom = parsed.customTitle?.trim() ?? "";
  if (custom.length > 0) {
    return { title: clipTitle(custom, TITLE_MAX_BYTES), titleSource: "customTitle" };
  }
  const ai = parsed.aiTitle?.trim() ?? "";
  if (ai.length > 0) {
    return { title: clipTitle(ai, TITLE_MAX_BYTES), titleSource: "aiTitle" };
  }
  const last = fallbackTitle(
    foldSkillCommand(stripInjectedContext(parsed.lastPrompt)),
    TITLE_FALLBACK_WORDS,
    TITLE_MAX_BYTES,
  );
  if (last) return { title: last, titleSource: "lastPrompt" };

  const summary = parsed.summary.trim();
  if (summary.length > 0) {
    return { title: clipTitle(summary, TITLE_MAX_BYTES), titleSource: "summary" };
  }
  const first = fallbackTitle(
    foldSkillCommand(parsed.firstUserText),
    TITLE_FALLBACK_WORDS,
    TITLE_MAX_BYTES,
  );
  if (first) return { title: first, titleSource: "firstMessage" };

  return { title: `Session ${parsed.id.slice(0, 8)}`, titleSource: "fallback" };
}

interface CacheEntry {
  signature: string;
  view: SessionView;
}

const viewCache = new Map<string, CacheEntry>();

/** 一个 jsonl 文件 → 一个会话视图。 */
async function readSessionView(
  path: string,
  override: { name?: string; hidden?: boolean } | undefined,
): Promise<SessionView | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const signature = `${info.size}|${info.mtimeMs}|${override?.name ?? ""}|${override?.hidden ?? ""}`;
  const cached = viewCache.get(path);
  if (cached !== undefined && cached.signature === signature) {
    return cached.view;
  }

  const parsed = await parseFile(path);
  if (override?.name && override.name.trim().length > 0) {
    parsed.customTitle = override.name.trim();
  }
  const { title, titleSource } = deriveTitle(parsed);
  const id =
    parsed.id.length > 0 ? parsed.id : (path.split(/[/\\]/).pop() ?? "").replace(/\.jsonl$/, "");

  const view: SessionView = {
    path,
    id,
    cwd: parsed.cwd ?? "",
    title,
    titleSource,
    preview: clipPreview(
      stripInjectedContext(parsed.firstUserText),
      PREVIEW_MAX_CHARACTERS,
    ),
    created: parsed.created ?? info.birthtime.toISOString(),
    modified: parsed.modified ?? info.mtime.toISOString(),
    messageCount: parsed.messageCount,
    hasSidechain: parsed.hasSidechain,
    hidden: override?.hidden === true,
    gitBranch: parsed.gitBranch.length > 0 ? parsed.gitBranch : undefined,
  };
  viewCache.set(path, { signature, view });
  return view;
}

export interface ListSessionsOptions {
  includeHidden?: boolean;
  limit?: number;
  /** 一个必须出现在结果里的会话路径，即使它排到了 `limit` 之外。 */
  focus?: string;
  signal?: AbortSignal;
}

export interface SessionListPage {
  sessions: SessionView[];
  total: number;
}

/**
 * 一个项目的会话列表。
 *
 * 与 pi-web 一样，会话从 CLI 自己的存储派生而不是镜像进自己的库，所以 Web UI
 * 与 `claude --resume` 永远看到同一份事实。
 *
 * 分组原则：**用 jsonl 行内的 `cwd` 过滤，不用目录名。** Claude Code 的 slug
 * 编码不可反推（实测 `E--code-Oracle` 与真实路径对不上），任何基于目录名的
 * 解码都会把会话归错项目。
 */
export async function listSessions(
  projectPath: string,
  options: ListSessionsOptions = {},
): Promise<SessionListPage> {
  const root = getSessionRoot();
  const target = resolve(projectPath);
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;

  let dirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return { sessions: [], total: 0 };
  }

  const files: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) files.push(join(dir, name));
  }

  const overrides = await getSessionOverrides();
  const views: SessionView[] = [];
  // 上限 64 并发：一个项目的会话数可能上千，不封顶会一次要上千个描述符。
  for (let index = 0; index < files.length; index += 64) {
    if (options.signal?.aborted === true) break;
    const batch = files.slice(index, index + 64);
    const parsed = await Promise.all(
      batch.map((path) => readSessionView(path, overrides[path])),
    );
    for (const view of parsed) {
      if (view === null) continue;
      // 只有 `cwd` 与目标项目一致的才归到这个项目下。
      const viewKey =
        process.platform === "win32" ? view.cwd.toLowerCase() : view.cwd;
      if (viewKey !== targetKey) continue;
      views.push(view);
    }
  }

  views.sort((a, b) => b.modified.localeCompare(a.modified));

  const visible =
    options.includeHidden === true ? views : views.filter((view) => !view.hidden);
  const sessions = options.limit === undefined ? visible : visible.slice(0, options.limit);
  const focus = options.focus;
  if (options.limit !== undefined && focus !== undefined) {
    if (!sessions.some((view) => view.path === focus)) {
      const found = visible.find((view) => view.path === focus);
      if (found !== undefined) sessions.push(found);
    }
  }
  return { sessions, total: visible.length };
}

/**
 * 所有已知项目目录（去重、按最近活跃排序）。
 *
 * 项目树要能列出「用户在这个项目里聊过」而不是「这个目录存在」，所以来源是
 * jsonl 的 `cwd` 集合。
 */
export async function listKnownProjects(): Promise<Array<{ path: string; modified: string }>> {
  const root = getSessionRoot();
  let dirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }

  const byPath = new Map<string, string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const parsed = await parseFile(path).catch(() => null);
      if (parsed === null || parsed.cwd === null) continue;
      const modified = parsed.modified ?? new Date(0).toISOString();
      const previous = byPath.get(parsed.cwd);
      if (previous === undefined || modified > previous) byPath.set(parsed.cwd, modified);
    }
  }
  return [...byPath.entries()]
    .map(([path, modified]) => ({ path, modified }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** 清掉解析缓存。升级 Claude Code 或外部改动 jsonl 后调用。 */
export function invalidateSessionCache(): void {
  viewCache.clear();
}
