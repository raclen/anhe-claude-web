/**
 * 模型生成的会话标题。
 *
 * **本版不实现。** 原因是一条架构边界，不是没做完：
 *
 * 这个调用需要向某个上游发一次模型请求，而本项目**不持有任何凭据** ——
 * 上游完全由 Claude Code 从它自己的 `settings.json` 与 shell 环境读取。
 * 偷偷复用那些凭据去发我们自己的请求，等于绕过用户对「谁能用我的 key」的预期，
 * 也等于把一个只在用户明确发消息时才应该发生的调用变成隐式的。
 *
 * 于是标题只有两级：`summary` 行（这个 CLI 版本不写）与首条用户消息。
 * 要更好的标题，请在终端里给会话改名，或者等 v2 引入一个**用户显式配置**的
 * 标题模型（独立的 key，与 Claude Code 的凭据分开）。
 *
 * 保留这个文件与签名，是为了 v2 接上时不用改调用点。
 */
import { cleanTitleText, truncateTitleBytes } from "./title-text.ts";

export interface CompleteTitleInput {
  /** 上游连接。本版永远拿不到（`readProviderConnection` 返回 undefined）。 */
  connection: unknown;
  model: string;
  text: string;
  signal?: AbortSignal;
}

/**
 * 从一段文本推一个「够用的」标题。
 *
 * 不是模型生成，而是确定性的截断 —— 但对外签名一致，所以 v2 换成真模型时
 * 调用方无感。输入是首条用户消息，输出是一行。
 */
export async function completeTitle(input: CompleteTitleInput): Promise<string> {
  const cleaned = cleanTitleText(input.text);
  return truncateTitleBytes(cleaned, 200);
}
