import { existsSync } from "node:fs";
import { readSessionSnapshot } from "./session-reader.ts";
import { listSessions } from "./agent/sessions.ts";

/**
 * 会话标题。
 *
 * 与 pi-web 的一处**根本差异**：Claude Code 的 jsonl 里没有 `session_info` 这种
 * 「给会话起名」的条目，也没有对应的 RPC。实测这个版本（2.1.309）连 `summary`
 * 行都不写。所以：
 *
 * - 自动标题（首条用户消息）来自 jsonl，是**派生**的，与 `claude --resume` 一致；
 * - 手动改名存进**本项目自己的 store**（`~/.anhe-claude-web`），
 *   绝不往 `~/.claude` 的 jsonl 里写 —— 见 PROJECT_RULES.md 硬边界 5。
 *
 * 代价：手动改的名字在终端里看不到。这是有意的取舍，写在
 * `docs/known-limitations.md` 里。
 */

/** 一个会话的当前标题（自动或手动）。 */
export async function sessionTitleOf(
  sessionPath: string,
  projectPath: string,
): Promise<string | undefined> {
  if (!existsSync(sessionPath)) return undefined;
  const page = await listSessions(projectPath, { includeHidden: true, focus: sessionPath });
  return page.sessions.find((view) => view.path === sessionPath)?.title;
}

/**
 * 从首条用户消息推导一个标题。
 *
 * 只在 store 里没有手动名字时用；推导逻辑与 `agent/sessions.ts` 的
 * `deriveTitle` 保持一致（那里是列表用的，这里是单会话用的）。
 */
export async function deriveTitleFromFile(sessionPath: string): Promise<string | undefined> {
  const snapshot = await readSessionSnapshot(sessionPath).catch(() => null);
  if (snapshot === null) return undefined;
  for (const message of snapshot.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part): part is { type: string; text: string } =>
                  typeof part === "object" &&
                  part !== null &&
                  (part as { type?: unknown }).type === "text" &&
                  typeof (part as { text?: unknown }).text === "string",
              )
              .map((part) => part.text)
              .join(" ")
          : "";
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 120);
  }
  return undefined;
}
