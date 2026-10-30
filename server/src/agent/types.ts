/**
 * 服务端与前端之间的消息形状。
 *
 * **为什么这里要重新定义，而不是从 `web/src/` 导入：**
 * 服务端构建的 `rootDir` 是 `server/src`，跨包 import 会让 `tsc -p tsconfig.build.json`
 * 直接失败（"is not under rootDir"）。而且从架构上说，这些类型是**跨进程契约**，
 * 不属于任何一侧的私有实现 —— 前端在 `web/src/lib/types.ts` 里有一份等价的声明，
 * 两边各自持有、靠协议对齐，比绕过构建边界去共享一个文件更诚实。
 *
 * 如果将来要真正共享，正确做法是抽一个 `shared/` 包，而不是让 server import web。
 *
 * 字段名与语义必须与 `web/src/lib/types.ts` 保持一致；改一处就要改另一处。
 */

/** Anthropic 的 token 用量，映射成前端用的四桶。 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ImageBlock
  | { type: string; [key: string]: unknown };

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
  attachments?: unknown[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  timestamp: number;
  errorMessage?: string;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  details?: unknown;
  usage?: Usage;
  isError?: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | { role: string; [key: string]: unknown };

/** 流式增量，`message_update` 里带的那个。 */
export type AssistantStreamEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallBlock }
  | { type: string; contentIndex?: number; [key: string]: unknown };

/** 输入栏右侧的模型描述。 */
export interface ComposerModel {
  provider: string;
  id: string;
  name: string | null;
  contextWindow: number;
  reasoning: boolean;
}

/** 上下文占用。 */
export interface ComposerContext {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  /** 实时 CLI 查询或最近一次回复的历史用量；历史用量不等于当前窗口占用。 */
  source: "live" | "usage";
}

/** 输入栏要渲染的全部状态。 */
export interface ComposerState {
  live: boolean;
  model: ComposerModel | null;
  models: ComposerModel[] | null;
  context: ComposerContext | null;
  thinkingLevel?: string | null;
}
