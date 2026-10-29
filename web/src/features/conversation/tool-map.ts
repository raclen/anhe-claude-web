/**
 * Claude Code 工具名 → 界面 variant 的映射。
 *
 * 为什么单独一个文件：`row-model.ts` 是从 dsh 逐字节移植来的，它的 `classify()`
 * 里那张表用的是**小写**工具名（pi 的风格）。Claude Code 报的是 PascalCase
 * （`Bash` / `Read` / `TodoWrite` / `mcp__firecrawl__scrape`）。与其去改那张移植来的
 * 表，不如在入口处做一次名字归一 —— 移植表保持原样，Claude Code 的名字集中在这里，
 * 将来 CLI 加新工具只改这一个文件。
 *
 * 这张表**不是**白名单：不在表里的工具照常渲染成 "其它"，不会丢。
 */

import type { Variant } from "./row-model.ts";

/**
 * Claude Code 的内置工具 → variant。
 *
 * 只映射「长得像某种已知形状」的工具。刻意**不**映射 `Task` / `TodoWrite` /
 * `AskUserQuestion` / `ExitPlanMode` —— 它们有自己的渲染路径（子代理折叠、
 * TodoPanel、QuestionCard、计划审批），归到任何一个 variant 都会丢失语义。
 */
export const CLAUDE_TOOL_VARIANTS: Record<string, Variant> = {
  // 命令
  Bash: "bash",
  BashOutput: "bash",
  KillBash: "bash",
  KillShell: "bash",

  // 读
  Read: "read",
  NotebookRead: "read",

  // 写
  Write: "write",
  NotebookEdit: "write",

  // 改
  Edit: "edit",
  MultiEdit: "edit",
};

/**
 * 把 Claude Code 的工具名归一成 `row-model.classify()` 认识的小写名。
 *
 * 三条规则，按顺序：
 * 1. 在内置表里 → 直接给出 variant 对应的名字。
 * 2. `mcp__<server>__<tool>` → 归到 `search`（MCP 工具的参数形状大多是
 *    `query` / `url`，用它读摘要最稳），并保留原名用于标题。
 * 3. 其它 → 原样小写返回，让 `classify()` 自己落到 `others`。
 *
 * 返回的是**名字**而不是 variant，因为 `row-model.ts` 里除了 variant 还要按名字
 * 查 `SUMMARY_KEYS`；把 variant 硬塞回去会绕开那层。
 */
export function normalizeToolName(toolName: string): string {
  const mapped = CLAUDE_TOOL_VARIANTS[toolName];
  if (mapped !== undefined) return mapped;

  if (toolName.startsWith("mcp__")) return "mcp";

  // 已经是小写的旧名字（pi 风格）原样放过，避免双重映射。
  return toolName.toLowerCase();
}

/** 展示用的工具名：MCP 工具剥掉冗长的前缀，其余原样。 */
export function displayToolName(toolName: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (mcp !== null) return mcp[2]!;
  return toolName;
}

/**
 * 这个工具是不是「自己有专属渲染」的那种。
 *
 * 给 `MessageList` 用：专属渲染的工具不套通用工具卡。
 */
export function hasDedicatedView(toolName: string): boolean {
  switch (toolName) {
    case "Task":
      return true; // 子代理折叠块
    case "TodoWrite":
      return true; // TodoPanel
    case "AskUserQuestion":
      return true; // QuestionCard
    case "ExitPlanMode":
      return true; // 计划审批卡
    default:
      return false;
  }
}
