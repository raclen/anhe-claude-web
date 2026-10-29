import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configSummary, listModels, readSettings, settingsPath } from "./agent/models.ts";

/**
 * 模型与上游配置：**只读展示**。
 *
 * 与 pi-web 最大的差异：pi-web 自己持有 provider 凭据（`models.json` + `auth.json`），
 * 所以它能编辑它们。本项目**不持有任何凭据** —— 上游完全由 Claude Code 从它自己的
 * `settings.json` 与 shell 环境读取，我们只是启动它。
 *
 * 这条边界带来两个直接后果：
 * 1. 这里只读，不写 `~/.claude/settings.json`。
 * 2. 能提供的最有用信息是「当前实际生效的是什么」，而不是「你可以配置什么」。
 */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

/** 一个候选模型的只读视图。 */
export interface ProviderModelEntry {
  id: string;
  name: string | null;
  contextWindow: number;
  reasoning: boolean;
}

/**
 * 「provider」在这个项目里的唯一含义是「Claude Code 自己」。
 *
 * 保留这个形状是为了不动前端设置页的结构：它渲染一组 provider，每个下面挂模型。
 * 我们只有一个 provider，名字如实写着它由 Claude Code 管理。
 */
export interface ModelProviderView {
  id: string;
  name: string;
  /** 上游地址。**已脱敏**：只报是否被覆盖，不报 URL 原文。 */
  baseUrl: string | null;
  /** 有没有配置凭据。永远不返回凭据本身。 */
  hasCredential: boolean;
  /** 本版不可编辑。 */
  readOnly: true;
  models: ProviderModelEntry[];
}

/** 配置文件的路径，供设置页展示。 */
export function modelsPath(): string {
  return settingsPath();
}

/** Claude Code 不把凭据放在单独的文件里；保留签名给调用方。 */
export function authPath(): string {
  return join(settingsPath(), "..", "auth.json");
}

/** 当前生效配置的目录（`~/.claude`）。 */
export function agentDir(): string {
  return join(settingsPath(), "..");
}

/**
 * 唯一的 provider 视图。
 *
 * 模型列表来自 `settings.json` 的 `modelPicker.options` ∪ 当前生效模型 ∪ 默认模型 ——
 * 全部动态读，不硬编码任何一个模型名。
 */
export async function readProviders(): Promise<ModelProviderView[]> {
  const settings = await readSettings();
  const summary = await configSummary();
  const models = await listModels(
    typeof settings.model === "string" ? settings.model : null,
  );

  return [
    {
      id: "claude-code",
      name: "Claude Code",
      // 只报「有没有被覆盖」，不报 URL。上游 URL 里可能带查询串或 token。
      baseUrl: summary.hasBaseUrlOverride ? "(已在 settings.json 中覆盖)" : null,
      hasCredential:
        summary.envKeys.includes("ANTHROPIC_AUTH_TOKEN") ||
        summary.envKeys.includes("ANTHROPIC_API_KEY"),
      readOnly: true,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
      })),
    },
  ];
}

/** 模型目录：provider → modelId → 条目。给输入栏的展示名兜底。 */
export type CatalogModel = ProviderModelEntry;
export type ModelCatalog = Map<string, Map<string, CatalogModel>>;

/** 读模型目录（含展示名与上下文窗口）。 */
export async function readModelCatalog(): Promise<ModelCatalog> {
  const settings = await readSettings();
  const models = await listModels(
    typeof settings.model === "string" ? settings.model : null,
  );
  const catalog: ModelCatalog = new Map();
  const inner = new Map<string, CatalogModel>();
  for (const model of models) {
    inner.set(model.id, {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    });
  }
  catalog.set("claude-code", inner);
  return catalog;
}

/** 写操作一律拒绝，并说明去哪改。 */
function refuse(): never {
  throw new ModelConfigError(
    "本版不写入 Claude Code 的模型配置。请编辑 ~/.claude/settings.json，或用终端里的 /config、/model。",
  );
}

export async function saveProvider(_input: unknown): Promise<never> {
  return refuse();
}

export async function deleteProvider(_id: string): Promise<never> {
  return refuse();
}

export async function fetchProviderModels(_input: unknown): Promise<never> {
  throw new ModelConfigError(
    "本版不支持从上游拉取模型列表。模型候选来自 ~/.claude/settings.json 的 modelPicker.options。",
  );
}

/** 上游连接信息。本项目不持有凭据，所以永远返回 undefined。 */
export interface ProviderConnection {
  baseUrl: string | null;
  apiKey: string;
  api: string | null;
}

export async function readProviderConnection(_id: string): Promise<ProviderConnection | undefined> {
  return undefined;
}

/** 拼请求头。保留签名，但本项目不会用到（不直接发模型请求）。 */
export function authHeaders(_api: string | null, _apiKey: string | undefined): Record<string, string> {
  return {};
}

/** 校验 provider id。本项目只有一个固定 provider。 */
export function validateProviderId(id: string): string {
  if (id !== "claude-code") {
    throw new ModelConfigError(`本项目只有一个 provider：claude-code（收到 ${id}）`);
  }
  return id;
}

/** 已知的 provider 名（只有一个）。 */
export const KNOWN_PROVIDERS: readonly string[] = ["claude-code"] as const;

/** API 协议取值。Claude Code 不用这个概念，保留空表。 */
export const API_PROTOCOLS: readonly string[] = [] as const;
