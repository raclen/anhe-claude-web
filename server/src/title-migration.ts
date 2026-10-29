/**
 * 旧版标题迁移。
 *
 * **本版为空操作。** pi-web 的旧 build 把改名存在 `store.json` 里，后来改成写进
 * 会话自己的 `session_info` 条目，于是需要一个迁移。
 *
 * Claude Code 的 jsonl **没有**「会话名」这个概念，也没有对应命令，所以那个迁移的
 * 目的地不存在。本项目的改名从一开始就存在自己的 store 里 —— 没有旧数据要搬。
 *
 * 保留这个函数与结果类型，是为了 `index.ts` 的启动序列不用改分支。
 */
export interface TitleMigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
}

export async function migrateLegacySessionTitles(
  _log: { warn(message: string): void } = console,
): Promise<TitleMigrationResult> {
  // 没有可迁移的东西：本项目的标题从一开始就在自己的 store 里。
  return { migrated: 0, skipped: 0, failed: 0 };
}
