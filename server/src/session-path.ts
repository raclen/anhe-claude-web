import { join, resolve, sep } from "node:path";
import { getSessionRoot } from "./agent/sessions.ts";
import { badRequest, forbidden } from "./errors.ts";

export { getSessionRoot };

/**
 * 一个项目的会话目录。
 *
 * **注意：这个 slug 只用于「找」目录，绝不用于「反推」项目路径。**
 * Claude Code 的编码不可逆（实测 `e:\code\Oracle` → `e--code-Oracle`，但真实规则
 * 不止小写与前缀），所以任何「从目录名解出 cwd」的尝试都会错。
 * 项目归属一律读 jsonl 每行的 `cwd` —— 见 `agent/sessions.ts`。
 */
export function sessionDirFor(cwd: string, root = getSessionRoot()): string {
  const resolved = resolve(cwd);
  return join(root, slugForProject(resolved));
}

/** 项目路径 → 目录 slug。写路径时用，读的时候不信它。 */
export function slugForProject(projectPath: string): string {
  return projectPath.toLowerCase().replace(/[:\\/]+/g, "-").replace(/^-+/, "");
}

/** 一个「还没落盘」的新会话的地址前缀。与前端 `DRAFT_PREFIX` 保持一致。 */
export const DRAFT_PREFIX = "draft:";

/** 这个 id 是不是一个 draft（新会话还没有 jsonl）。 */
export function isDraftPath(input: string): boolean {
  return input.startsWith(DRAFT_PREFIX);
}

/** `draft:<项目路径>` → 项目路径。 */
export function draftProjectPath(input: string): string {
  return input.slice(DRAFT_PREFIX.length);
}

/** 为一个还没落盘的新会话造一个地址。 */
export function makeDraftPath(projectPath: string): string {
  return `${DRAFT_PREFIX}${projectPath}`;
}

/**
 * 拒绝 `~/.claude/projects` 之外的会话路径。
 *
 * 没有这道检查，一个能访问本机服务端的页面就能让它把任意文件当会话打开。
 */
export function assertAllowedSessionPath(input: string, root = getSessionRoot()): string {
  if (typeof input !== "string" || input.length === 0) {
    throw badRequest("sessionPath is required");
  }
  const path = resolve(input);
  if (!path.endsWith(".jsonl")) {
    throw badRequest(`not a session file: ${path}`);
  }
  if (path !== root && !path.startsWith(root + sep)) {
    throw forbidden(`session path is outside ${root}`);
  }
  return path;
}
