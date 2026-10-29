import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionSnapshot } from "./session-reader.ts";

/**
 * 把一个会话导出成一份自包含的 HTML。
 *
 * 为什么自己做而不是让 CLI 导：Claude Code 的 stream-json 面没有导出命令，
 * 而 jsonl 已经在我们手上 —— 渲染它比再起一个进程便宜得多。
 *
 * 安全要点：**所有用户与模型文本都经 HTML 转义**。这份文件会被浏览器直接打开，
 * 里面装着任意来源的模型输出；不转义等于把一段 XSS 装进文件交给用户收藏。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 一条消息 → 一段 HTML。 */
function renderMessage(message: unknown): string {
  const raw = message as {
    role?: string;
    content?: unknown;
    timestamp?: number;
    model?: string;
    toolCallId?: string;
    isError?: boolean;
  };
  const role = raw.role ?? "unknown";
  const label =
    role === "assistant" ? "助手" : role === "toolResult" ? "工具结果" : role === "user" ? "你" : role;
  const when =
    typeof raw.timestamp === "number" ? new Date(raw.timestamp).toLocaleString("zh-CN") : "";

  const parts: string[] = [];
  const content = raw.content;
  if (typeof content === "string") {
    parts.push(`<pre>${escapeHtml(content)}</pre>`);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(`<pre>${escapeHtml(b.text)}</pre>`);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        parts.push(`<details><summary>思考</summary><pre>${escapeHtml(b.thinking)}</pre></details>`);
      } else if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "";
        const args = JSON.stringify(b.arguments ?? {}, null, 2);
        parts.push(
          `<div class="tool"><div class="tool-name">${escapeHtml(name)}</div><pre>${escapeHtml(args)}</pre></div>`,
        );
      } else if (b.type === "image") {
        parts.push(`<div class="image">[图片]</div>`);
      }
    }
  }

  const errorClass = raw.isError === true ? ' class="error"' : "";
  return `<section class="msg ${role}"${errorClass}>
  <header><span class="role">${escapeHtml(label)}</span><time>${escapeHtml(when)}</time></header>
  ${parts.join("\n  ")}
</section>`;
}

/**
 * 写一份 HTML 到磁盘。
 *
 * 默认路径与会话文件同级、同名 `.html`；给了 `target` 就按它写（相对路径按会话
 * 所在目录解析）。
 */
export async function writeTranscriptHtml(
  sessionPath: string,
  snapshot: SessionSnapshot,
  target?: string,
): Promise<string> {
  const outPath =
    target === undefined || target.trim().length === 0
      ? sessionPath.replace(/\.jsonl$/, ".html")
      : resolve(dirname(sessionPath), target.trim());

  const body = snapshot.messages.map(renderMessage).join("\n");
  const title = `会话 ${snapshot.sessionId.slice(0, 8)}`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; opacity: .7; font-weight: 500; }
  .msg { border-left: 3px solid #d0d0d0; padding: .5rem 0 .5rem 1rem; margin: 1rem 0; }
  .msg.user { border-color: #4a86c8; }
  .msg.assistant { border-color: #6aa84f; }
  .msg.toolResult { border-color: #c8a24a; }
  .msg.error { border-color: #c84a4a; }
  header { display: flex; gap: .75rem; align-items: baseline; font-size: .85rem; opacity: .7; }
  .role { font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; margin: .35rem 0; font: inherit; }
  .tool { background: rgba(128,128,128,.08); border-radius: 6px; padding: .5rem .75rem; }
  .tool-name { font-weight: 600; font-size: .85rem; opacity: .8; }
  .image { font-style: italic; opacity: .6; }
  details summary { cursor: pointer; opacity: .7; font-size: .9rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return outPath;
}
