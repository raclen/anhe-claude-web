import type {
  ComposerContext,
  ComposerModel as WebComposerModel,
  ComposerState,
  Usage,
} from "./agent/types.ts";

/** 转发给 routes.ts —— 它从 pi-web 的 `./composer.ts` 导入这个类型。 */
export type { ComposerContext, ComposerState, Usage };
import { listModels, readSettings, type ComposerModel } from "./agent/models.ts";
import type { SessionHandle } from "./agent/registry.ts";
import { readSessionSnapshot } from "./session-reader.ts";

/**
 * 输入栏右侧要渲染的东西：当前模型、可选模型、上下文占用。
 *
 * 三个来源不同，别混：
 * - **运行中**：`system:init` 的 `model` 就是权威，`modelPicker.options` 是候选。
 * - **从磁盘**：jsonl 里最后一条 assistant 的 `message.model` 与它的 `usage`。
 * - **新会话**：`settings.model` 决定默认值，候选仍来自 `modelPicker.options`。
 *
 * 没有任何一项是硬编码的模型名 —— 上游改名、用户改配置，这里跟着变。
 */

function toWebModel(model: ComposerModel): WebComposerModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
  };
}

/**
 * 一次 assistant 回复的 usage，不可用时返回 null。
 *
 * 被中断或报错的回复不算：它们从未描述过一个完整的上下文。
 */
function usableUsage(usage: Usage | undefined, stopReason: string | undefined): Usage | null {
  if (usage === undefined) return null;
  if (stopReason === "aborted" || stopReason === "error") return null;
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  return total > 0 ? usage : null;
}

/**
 * 一次回复用掉的上下文 token 数。
 *
 * Claude Code 的 usage 语义与 Anthropic API 一致：`input_tokens` 不含缓存部分，
 * 所以真实上下文 = input + cache_read + cache_creation。`output_tokens` 是这一轮
 * 新生成的，下一轮会作为 input 的一部分被计入，所以**也算进来**（用户看的是
 * 「这轮之后窗口有多满」）。
 */
function contextTokensFrom(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * 从磁盘推导上下文占用。
 *
 * 基准是最后一条可用 assistant 的 usage；它之后的消息按字符数粗估追加。
 * 粗估的规则刻意保守（4 字符 ≈ 1 token），因为这个数字是用来给用户一个量级，
 * 不是用来算钱的。
 */
export function estimateContextTokens(
  messages: Array<{ role: string; content?: unknown }>,
): number {
  let base = 0;
  let lastIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const assistant = message as { usage?: Usage; stopReason?: string };
    const usage = usableUsage(assistant.usage, assistant.stopReason);
    if (usage !== null) {
      base = contextTokensFrom(usage);
      lastIndex = index;
      break;
    }
  }

  let trailing = 0;
  for (let index = lastIndex + 1; index < messages.length; index += 1) {
    trailing += estimateMessageChars(messages[index]!);
  }
  // 4 字符 ≈ 1 token，向上取整。
  return base + Math.ceil(trailing / 4);
}

function estimateMessageChars(message: { content?: unknown }): number {
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const raw = part as Record<string, unknown>;
    if (typeof raw.text === "string") total += raw.text.length;
    else if (typeof raw.thinking === "string") total += raw.thinking.length;
    else if (typeof raw.arguments === "object" && raw.arguments !== null) {
      total += JSON.stringify(raw.arguments).length;
    }
  }
  return total;
}

/** 一条从 jsonl 还原的会话 → 输入栏状态。 */
export async function readComposerFromDisk(
  sessionPath: string,
  contextWindowHint?: number,
): Promise<ComposerState> {
  const snapshot = await readSessionSnapshot(sessionPath).catch(() => null);
  if (snapshot === null) {
    return { live: false, model: null, models: null, context: null };
  }

  // 最后一条 assistant 的模型就是当前模型。
  let modelId: string | null = null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]!;
    if (message.role !== "assistant") continue;
    const assistant = message as { model?: string };
    if (typeof assistant.model === "string" && assistant.model.length > 0) {
      modelId = assistant.model;
      break;
    }
  }

  const candidates = await listModels(modelId);
  const found = modelId === null ? undefined : candidates.find((entry) => entry.id === modelId);
  const model: WebComposerModel | null =
    modelId === null
      ? null
      : toWebModel(
          found ?? {
            provider: "claude",
            id: modelId,
            name: modelId,
            contextWindow: contextWindowHint ?? 0,
            reasoning: false,
          },
        );

  const contextWindow = model?.contextWindow ?? contextWindowHint ?? 0;
  const context: ComposerContext | null =
    contextWindow > 0
      ? (() => {
          const tokens = estimateContextTokens(
            snapshot.messages as Array<{ role: string; content?: unknown }>,
          );
          return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
        })()
      : null;

  return { live: false, model, models: null, context };
}

/** 一个运行中的会话 → 输入栏状态（权威视图）。 */
export async function readComposerFromHandle(handle: SessionHandle): Promise<ComposerState> {
  const settings = await readSettings();
  const current = handle.initModel ?? settings.model ?? null;
  const candidates = await listModels(current);
  const found = current === null ? undefined : candidates.find((entry) => entry.id === current);
  const model: WebComposerModel | null =
    current === null
      ? null
      : toWebModel(
          found ?? {
            provider: "claude",
            id: current,
            name: current,
            contextWindow: 0,
            reasoning: false,
          },
        );

  const contextWindow = model?.contextWindow ?? 0;
  const tokens = handle.lastUsage;
  const context: ComposerContext | null =
    contextWindow > 0 && tokens !== null
      ? { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
      : null;

  return {
    live: true,
    model,
    models: candidates.map(toWebModel),
    context,
  };
}

/**
 * 一个还不存在的会话 → 英雄区的选择器。
 *
 * 两个答案都来自文件：`settings.model` 是默认模型，`modelPicker.options` 是候选。
 * `context` 按构造就是 null —— 没有轮次的会话没有窗口可报，显示 0% 会被当成测量值。
 */
export async function readComposerFromDefaults(): Promise<ComposerState> {
  const settings = await readSettings();
  const defaultModel = typeof settings.model === "string" ? settings.model : null;
  const candidates = await listModels(defaultModel);
  const found =
    defaultModel === null ? undefined : candidates.find((entry) => entry.id === defaultModel);
  return {
    live: false,
    model: found ? toWebModel(found) : (candidates[0] ? toWebModel(candidates[0]) : null),
    models: candidates.map(toWebModel),
    context: null,
  };
}
