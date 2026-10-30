import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 模型列表：全部动态读，不写死任何模型名。
 *
 * 三个来源，合并成一个候选集：
 *   1. `system:init.model` —— 当前实际生效的模型（运行时才知道）
 *   2. `~/.claude/settings.json` 的 `modelPicker.options[]` —— 用户的候选清单
 *   3. `modelSettings.<model>.effortLevel` —— 每个模型的推理强度
 *
 * 为什么不硬编码：上游改名字、用户改配置、企业版下发不同的清单，写死就一定会过期。
 */

/** 一个可选模型，字段只保留输入栏要渲染的。 */
export interface ComposerModel {
  provider: string;
  id: string;
  /** 展示名。null 时 UI 退回显示 id。 */
  name: string | null;
  /** 上下文窗口。0 表示未知。 */
  contextWindow: number;
  /** 是否支持推理强度调节。 */
  reasoning: boolean;
}

/** `settings.json` 里我们关心的那部分。 */
interface ClaudeSettings {
  model?: string;
  modelPicker?: {
    options?: Array<{
      model?: string;
      label?: string;
      description?: string;
      contextWindow?: number;
    }>;
  };
  modelSettings?: Record<
    string,
    {
      effortLevel?: string;
      supportsReasoning?: boolean;
      contextWindow?: number;
    }
  >;
  env?: Record<string, string>;
  permissions?: {
    defaultMode?: string;
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
}

/** `~/.claude/settings.json` 的路径。每次调用重新解析（验收会改 HOME）。 */
export function settingsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".claude", "settings.json");
}

/** 读用户配置。文件不存在或坏掉时返回空对象，不抛。 */
export async function readSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeSettings) : {};
  } catch {
    return {};
  }
}

/**
 * 合并候选模型。
 *
 * `currentModel` 来自运行中的 `system:init`，可能不在 `modelPicker.options` 里
 * （用户直接 `--model` 指定、或 CLI 内部映射过）——所以它**单独**也要进列表，
 * 否则下拉框会显示一个选不中的值。
 */
export async function listModels(currentModel?: string | null): Promise<ComposerModel[]> {
  const settings = await readSettings();
  const seen = new Set<string>();
  const models: ComposerModel[] = [];

  const push = (id: string, name: string | null, reasoningHint?: boolean, contextWindow?: number) => {
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    const cleanId = trimmed.replace(/\[.*?\]$/, "");
    const perModel = settings.modelSettings?.[trimmed] ?? settings.modelSettings?.[cleanId];
    // 只有在显式设置 supportsReasoning: false 时才禁用
    const explicitlyDisabled = perModel?.supportsReasoning === false;
    const reasoning = reasoningHint ?? !explicitlyDisabled;
    models.push({
      provider: "claude",
      id: trimmed,
      // 展示名：显式给了就用，否则退回 id。绝不用 effortLevel 推断名字。
      name: name ?? trimmed,
      contextWindow: contextWindow ?? perModel?.contextWindow ?? 0,
      reasoning,
    });
  };

  for (const option of settings.modelPicker?.options ?? []) {
    if (typeof option.model !== "string") continue;
    push(option.model, option.label ?? null, undefined, option.contextWindow);
  }

  // 当前生效的模型必须在列表里，哪怕 settings 没列它。
  if (typeof currentModel === "string" && currentModel.length > 0) {
    push(currentModel, null);
  }

  // `settings.model` 是默认模型，同样要在列表里。
  if (typeof settings.model === "string" && settings.model.length > 0) {
    push(settings.model, null);
  }

  return models;
}

/** 某个模型的推理强度，没有配置则 null。 */
export async function effortLevelFor(model: string): Promise<string | null> {
  const settings = await readSettings();
  const cleanId = model.replace(/\[.*?\]$/, "");
  const level =
    settings.modelSettings?.[model]?.effortLevel ??
    settings.modelSettings?.[cleanId]?.effortLevel;
  return typeof level === "string" ? level : null;
}

/** 保存某个模型的推理强度到 settings.json，与 VS Code 插件行为对齐。 */
export async function saveEffortLevel(model: string, level: string): Promise<void> {
  const p = settingsPath();
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    if (!parsed.modelSettings || typeof parsed.modelSettings !== "object") {
      parsed.modelSettings = {};
    }
    const cleanId = model.replace(/\[.*?\]$/, "");
    if (!parsed.modelSettings[cleanId] || typeof parsed.modelSettings[cleanId] !== "object") {
      parsed.modelSettings[cleanId] = {};
    }
    parsed.modelSettings[cleanId].effortLevel = level;
    if (model !== cleanId) {
      if (!parsed.modelSettings[model] || typeof parsed.modelSettings[model] !== "object") {
        parsed.modelSettings[model] = {};
      }
      parsed.modelSettings[model].effortLevel = level;
    }
    await writeFile(p, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch {
    // 忽略写入失败，避免影响运行时响应
  }
}

/**
 * 当前生效配置的摘要，给设置页展示。
 *
 * **不返回任何密钥** —— `env` 只报键名与是否存在，绝不返回值。
 */
export async function configSummary(): Promise<{
  path: string;
  model: string | null;
  permissionDefaultMode: string | null;
  envKeys: string[];
  hasBaseUrlOverride: boolean;
}> {
  const settings = await readSettings();
  const envKeys = Object.keys(settings.env ?? {});
  return {
    path: settingsPath(),
    model: typeof settings.model === "string" ? settings.model : null,
    permissionDefaultMode:
      typeof settings.permissions?.defaultMode === "string"
        ? settings.permissions.defaultMode
        : null,
    // 只给键名。值是 token / URL，前端不该看到，日志更不该。
    envKeys,
    hasBaseUrlOverride: envKeys.includes("ANTHROPIC_BASE_URL"),
  };
}
