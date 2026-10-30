import type {
  ComposerContext,
  ComposerModel as WebComposerModel,
  ComposerState,
  Usage,
} from "./agent/types.ts";

/** 转发给 routes.ts —— 它从 pi-web 的 `./composer.ts` 导入这个类型。 */
export type { ComposerContext, ComposerState, Usage };
import { effortLevelFor, listModels, readSettings, type ComposerModel } from "./agent/models.ts";
import type { SessionHandle } from "./agent/registry.ts";
import { readSessionSnapshot } from "./session-reader.ts";
import { knownSessionWindow } from "./store.ts";

/**
 * 输入栏右侧要渲染的东西：当前模型、可选模型、上下文占用。
 *
 * 三个来源不同，别混：
 * - **运行中**：`system:init` 的 `model` 就是权威，`modelPicker.options` 是候选。
 * - **从磁盘**：jsonl 里最后一条 assistant 的 `message.model` 与它的 `usage`。
 * - **新会话**：`settings.model` 决定默认值，候选仍来自 `modelPicker.options`。
 *
 * 没有任何一项是硬编码的模型名 —— 上游改名、用户改配置，这里跟着变。
 * 上下文优先询问 CLI；历史 usage 标明来源，不按字符数补齐，不当成当前占用。
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

/** 最近一条完整、非错误的 assistant 回复上报的用量。 */
export function lastContextTokens(messages: Array<{ role: string }>): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const assistant = message as { usage?: Usage; stopReason?: string; errorMessage?: string };
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || assistant.errorMessage) continue;
    const usage = assistant.usage;
    if (usage === undefined) continue;
    // input 不含缓存；输出也占用回复之后的上下文。四项都是该次请求的实测值。
    const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (Number.isFinite(tokens) && tokens > 0) return tokens;
  }
  return null;
}

function usageContext(tokens: number | null, contextWindow: number): ComposerContext | null {
  if (tokens === null && contextWindow <= 0) return null;
  return {
    tokens,
    contextWindow,
    percent: tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
    source: "usage",
  };
}

/** 一条从 jsonl 还原的会话 → 输入栏状态，不启动进程。 */
export async function readComposerFromDisk(sessionPath: string): Promise<ComposerState> {
  const snapshot = await readSessionSnapshot(sessionPath).catch(() => null);
  if (snapshot === null) {
    return { live: false, model: null, models: null, context: null };
  }

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
  const knownWindow = await knownSessionWindow(sessionPath, modelId);
  const contextWindow = knownWindow > 0 ? knownWindow : (found?.contextWindow ?? 0);
  const model: WebComposerModel | null = modelId === null ? null : {
    ...(found ? toWebModel(found) : { provider: "claude", id: modelId, name: modelId, reasoning: false }),
    contextWindow,
  };
  const context = usageContext(lastContextTokens(snapshot.messages), contextWindow);
  const thinkingLevel = modelId === null ? "auto" : ((await effortLevelFor(modelId)) ?? "auto");
  return { live: false, model, models: null, context, thinkingLevel };
}

/** 一个运行中的会话 → 输入栏状态，控制查询不发送用户消息。 */
export async function readComposerFromHandle(handle: SessionHandle): Promise<ComposerState> {
  const [settings, disk, queried] = await Promise.all([
    readSettings(),
    readComposerFromDisk(handle.sessionPath),
    handle.client.getContextUsage().catch(() => null),
  ]);
  // resume 在首条 prompt 之前没有 system:init，先用此会话历史模型，不能串成全局默认模型。
  const current = handle.initModel ?? disk.model?.id ?? settings.model ?? null;
  const candidates = await listModels(current);
  const found = current === null ? undefined : candidates.find((entry) => entry.id === current);
  const sameDiskModel = disk.model?.id === current;
  const contextWindow = queried?.contextWindow ?? (sameDiskModel && disk.context !== null
    ? disk.context.contextWindow
    : (found?.contextWindow ?? 0));
  const model: WebComposerModel | null = current === null ? null : {
    ...(found ? toWebModel(found) : { provider: "claude", id: current, name: current, reasoning: false }),
    contextWindow,
  };
  const context = queried ?? usageContext(handle.lastUsage ?? disk.context?.tokens ?? null, contextWindow);
  const thinkingLevel =
    handle.thinkingLevel ??
    (current === null ? "auto" : ((await effortLevelFor(current)) ?? "auto"));

  return {
    live: true,
    model,
    models: candidates.map(toWebModel),
    context,
    thinkingLevel,
  };
}

/** 尚未发消息的新会话没有上下文用量，不能把 0% 当成测量值。 */
export async function readComposerFromDefaults(): Promise<ComposerState> {
  const settings = await readSettings();
  const defaultModel = typeof settings.model === "string" ? settings.model : null;
  const candidates = await listModels(defaultModel);
  const found =
    defaultModel === null ? undefined : candidates.find((entry) => entry.id === defaultModel);
  const targetModel = defaultModel ?? candidates[0]?.id ?? null;
  const thinkingLevel = targetModel === null ? "auto" : ((await effortLevelFor(targetModel)) ?? "auto");
  return {
    live: false,
    model: found ? toWebModel(found) : (candidates[0] ? toWebModel(candidates[0]) : null),
    models: candidates.map(toWebModel),
    context: null,
    thinkingLevel,
  };
}
