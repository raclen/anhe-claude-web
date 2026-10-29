import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentMessage, ContentBlock, Usage } from "./agent/types.ts";

/**
 * 直接从 jsonl 读一个会话，不需要起一个 `claude` 进程。
 *
 * 为什么不用 `--resume` 再问它：冷启动一个进程要 1–2 秒，而对话记录本来就躺在
 * 磁盘上。切到一个没驻留的会话时，那 1–2 秒就是「正在载入会话…」的全部成本。
 *
 * 顺带一个好处：jsonl 是**权威**的。进程内视角可能因为压缩、截断而与文件不同，
 * 而文件是用户 `claude --resume` 看到的那一份。
 */
export interface SessionSnapshot {
  sessionId: string;
  messages: AgentMessage[];
  /**
   * 用户可以 fork 的位置：每个真实的人类消息一个。
   *
   * Claude Code 的 fork 是 `--resume <id> --fork-session`，粒度是**整个会话**，
   * 不是某一条消息。所以这里给的是「消息 → 它在会话里的位置」，用于 UI 展示
   * 「从这条往后分叉」的语义，实际执行时 fork 整个会话再重放前缀。
   */
  forkPoints: ForkPoint[];
}

/**
 * 一个可 fork 的点。
 *
 * `entryId` 是那条 user 消息的 `uuid`（Claude Code 给每一行都发 uuid），
 * 也是我们重放前缀时的锚点。
 */
export interface ForkPoint {
  entryId: string;
  text: string;
}

/** 把一条消息的 content 压成文本，用于匹配与预览。 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      );
    })
    .map((part) => part.text)
    .join("");
}

/** Claude Code 的 usage → 前端的 `Usage`。 */
function toUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite: num("cache_creation_input_tokens"),
  };
}

/** Anthropic 的 content block → 前端的 `ContentBlock`。 */
function toContentBlocks(content: unknown): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (typeof content === "string") {
    if (content.length > 0) out.push({ type: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const raw = part as Record<string, unknown>;
    switch (raw.type) {
      case "text":
        out.push({ type: "text", text: typeof raw.text === "string" ? raw.text : "" });
        break;
      case "thinking":
        out.push({
          type: "thinking",
          thinking: typeof raw.thinking === "string" ? raw.thinking : "",
        });
        break;
      case "tool_use":
        out.push({
          type: "toolCall",
          id: typeof raw.id === "string" ? raw.id : "",
          name: typeof raw.name === "string" ? raw.name : "",
          arguments:
            typeof raw.input === "object" && raw.input !== null
              ? (raw.input as Record<string, unknown>)
              : {},
        });
        break;
      case "tool_result": {
        // 工具结果在 jsonl 里是**独立**的一行，`type: "user"` + `tool_result` 块。
        // 前端把它当 `toolResult` 消息渲染（挂在对应的工具卡下），所以这里不产出
        // content block，由调用方按行类型分派。
        break;
      }
      case "image": {
        const source = raw.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          out.push({
            type: "image",
            data: source.data,
            mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 去掉 IDE 注入的上下文（选区、打开的文件），它们不是用户说的话。 */
function stripInjectedContext(text: string): string {
  return text
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

/**
 * 读一个会话文件，还原成前端能直接渲染的消息数组。
 *
 * 分派规则（对应 jsonl 的 `type`）：
 *   user + tool_result 块 → `toolResult` 消息（挂到工具卡下）
 *   user（纯文本）        → `user` 消息
 *   assistant            → `assistant` 消息
 *   `isSidechain: true`  → 跳过（子代理的内部对话，主转写里不展开）
 *   其它（attachment / file-history-snapshot / queue-operation …）→ 跳过
 */
export async function readSessionSnapshot(sessionPath: string): Promise<SessionSnapshot> {
  const messages: AgentMessage[] = [];
  const forkPoints: ForkPoint[] = [];
  let sessionId = "";

  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // 半行或格式变化。跳过，不让一行坏掉整个会话。
        continue;
      }

      if (sessionId.length === 0 && typeof raw.sessionId === "string") {
        sessionId = raw.sessionId;
      }
      if (raw.isSidechain === true) continue;

      const type = raw.type;
      if (type !== "user" && type !== "assistant") continue;

      const message = raw.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const timestamp =
        typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) || Date.now() : Date.now();
      const content = message.content;

      // 工具结果：单独成一条 `toolResult` 消息。
      if (type === "user" && Array.isArray(content)) {
        const toolResults = content.filter(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "tool_result",
        ) as Array<Record<string, unknown>>;
        if (toolResults.length > 0) {
          for (const result of toolResults) {
            const blocks = toContentBlocks(result.content);
            if (blocks.length === 0 && typeof result.content === "string") {
              blocks.push({ type: "text", text: result.content });
            }
            messages.push({
              role: "toolResult",
              toolCallId: typeof result.tool_use_id === "string" ? result.tool_use_id : "",
              toolName: typeof result.tool_name === "string" ? result.tool_name : "",
              content: blocks,
              isError: result.is_error === true,
              timestamp,
            } as AgentMessage);
          }
          continue;
        }
      }

      if (type === "user") {
        const blocks = toContentBlocks(content);
        const text = stripInjectedContext(messageText(content));
        // 只有一条纯文本时保持字符串形状，与前端 `userContent()` 的产出一致。
        const normalized: string | ContentBlock[] =
          blocks.length === 1 && blocks[0]?.type === "text" ? text : blocks;
        if (typeof normalized === "string" && normalized.length === 0) continue;
        messages.push({ role: "user", content: normalized, timestamp } as AgentMessage);
        forkPoints.push({
          entryId: typeof raw.uuid === "string" ? raw.uuid : "",
          text,
        });
        continue;
      }

      // assistant
      messages.push({
        role: "assistant",
        content: toContentBlocks(content),
        model: typeof message.model === "string" ? message.model : undefined,
        stopReason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
        usage: toUsage(message.usage),
        timestamp,
        errorMessage:
          raw.is_api_error_message === true && typeof raw.error === "string"
            ? raw.error
            : undefined,
      } as AgentMessage);
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { sessionId, messages, forkPoints };
}
