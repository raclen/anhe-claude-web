/**
 * 会话列表的服务端入口。
 *
 * 真正的实现在 `agent/sessions.ts`（扫描 `~/.claude/projects`、用行内 `cwd` 分组）。
 * 本文件只做一件事：把「本项目自己的 store」里的隐藏标记叠上去，
 * 这样 `hidden` 是 UI 的偏好，而不是 Claude Code 的事实。
 */
import {
  listSessions as listFromClaude,
  type ListSessionsOptions,
  type SessionListPage,
  type SessionView,
  type TitleSource,
} from "./agent/sessions.ts";
import { getSessionOverrides } from "./projects.ts";
import type { SessionOverride } from "./store.ts";

export type { ListSessionsOptions, SessionListPage, SessionView, TitleSource };

/** 把 store 的隐藏标记叠到派生视图上。 */
export function toSessionView(
  view: SessionView,
  override: SessionOverride | undefined,
): SessionView {
  return { ...view, hidden: override?.hidden === true };
}

/**
 * 某个项目的会话，按最近更新倒序。
 *
 * `limit` 是侧边栏一屏的行数；`focus` 保证当前打开的会话即使排到 `limit` 之外
 * 也仍在结果里，否则从别处打开一个老会话时会没有标题。
 */
export async function listSessions(
  projectPath: string,
  options: ListSessionsOptions = {},
): Promise<SessionListPage> {
  const [page, overrides] = await Promise.all([
    listFromClaude(projectPath, { ...options, includeHidden: true }),
    getSessionOverrides(),
  ]);

  const withOverrides = page.sessions.map((view) => toSessionView(view, overrides[view.path]));
  const visible =
    options.includeHidden === true
      ? withOverrides
      : withOverrides.filter((view) => !view.hidden);

  // limit 已经在派生层切过，这里只是重新算 total 并保证 focus 在。
  const sessions =
    options.limit === undefined ? visible : visible.slice(0, options.limit);
  const focus = options.focus;
  if (options.limit !== undefined && focus !== undefined) {
    if (!sessions.some((view) => view.path === focus)) {
      const found = visible.find((view) => view.path === focus);
      if (found !== undefined) sessions.push(found);
    }
  }
  // 派生层是按 includeHidden: true 切的 limit，隐藏项被算进去了；可见数要重算。
  return { sessions, total: visible.length };
}
