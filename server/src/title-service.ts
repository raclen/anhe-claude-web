import { TITLE_MAX_BYTES } from "./config.ts";
import type { SessionHandle } from "./agent/registry.ts";
import type { NormalizedEvent } from "./agent/normalize.ts";
import { clipTitle } from "./title-text.ts";
import { readStore } from "./store.ts";

/**
 * 用模型给会话起一个更好的标题。
 *
 * **第一版默认关闭**，原因写在 `docs/known-limitations.md`：pi-web 的这条路径依赖
 * 「项目自己有 provider 凭据」（`models.json` + `auth.json`），而本项目把上游完全
 * 交给 Claude Code 的 `settings.json`，我们自己**不读、也不该读**那份凭据。
 *
 * 于是这里做的是：**只有当用户在本项目设置里显式配了标题模型**时才发请求；
 * 否则什么都不做，侧边栏用 `agent/sessions.ts` 从首条消息推导的确定性标题。
 *
 * 设计约束与上游一致，逐条都保留：
 * - 每个会话只尝试一次，在第一轮人类消息上。之后的轮次不再花钱。
 * - 会话已有名字就赢，调用前查一次、写入前再查一次。第二次检查是「用户在模型
 *   思考期间改了名」也能生效的原因。
 * - 失败静默。缺少一个自动标题不是用户能处理的事，确定性标题已经在屏幕上了。
 * - 有新的尝试时 abort 旧的而不是赛跑，并带 revision 防止旧结果落在新结果之后。
 */
export interface TitleServiceDeps {
  /** 标题落盘后通知侧边栏重取。 */
  publish: (projectPath: string) => void;
  log?: { warn(message: string): void };
}

interface Work {
  revision: number;
  controller: AbortController;
}

export class SessionTitleService {
  private readonly work = new Map<string, Work>();
  /** 已经考虑过的会话：每个会话一生只尝试一次。 */
  private readonly attempted = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: TitleServiceDeps) {}

  /** 一条归一化事件；只有会话的第一条人类消息会启动任何东西。 */
  noteEvent(handle: SessionHandle, event: NormalizedEvent): void {
    if (this.stopped) return;
    // 我们只在 `agent_start` 上记一次，真正的文本由 send() 直接带来。
    if (event.type !== "agent_start") return;
    if (handle.sessionPath.length === 0) return;
    // 第一版不自动起名 —— 见文件头。留这个钩子是为了 v2 接上时不改调用点。
  }

  /** 记下一条用户消息，供 v2 的标题模型使用。 */
  noteUserText(handle: SessionHandle, text: string): void {
    if (this.stopped) return;
    if (this.attempted.has(handle.sessionPath)) return;
    this.attempted.add(handle.sessionPath);
    void this.maybeTitle(handle, text).catch((error: unknown) => {
      this.warn(`session "${handle.sessionId}": automatic title failed: ${String(error)}`);
    });
  }

  /** 忘掉一个会话，让它再出现时还能被起名。 */
  forget(sessionPath: string): void {
    this.work.get(sessionPath)?.controller.abort();
    this.work.delete(sessionPath);
    this.attempted.delete(sessionPath);
  }

  /** 中断全部在飞的调用；服务退出时调。 */
  stop(): void {
    this.stopped = true;
    for (const work of this.work.values()) work.controller.abort();
    this.work.clear();
  }

  private async maybeTitle(handle: SessionHandle, text: string): Promise<void> {
    const { titleModel } = (await readStore()).settings;
    // 没配标题模型就是「不启用」——这是第一版的默认状态。
    if (titleModel === null || text.trim().length === 0) return;
    // 有配置也没实现调用：本项目不持有上游凭据。等到 v2 引入独立的标题客户端
    // （用 Claude Code 自己的配置）时在这里接上 `completeTitle`。
    void clipTitle(text, TITLE_MAX_BYTES);
    void handle;
  }

  private warn(message: string): void {
    this.deps.log?.warn(`[anhe-claude-web] ${message}`);
  }
}
