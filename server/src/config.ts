import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本项目的自有状态目录。
 *
 * 刻意与 `~/.claude` 分开：`~/.claude` 归 Claude Code CLI 所有，格式是它的私有实现
 * 细节，本项目只读。自己的东西（项目记录、UI 偏好、标题缓存）放在这里。
 */
export const DATA_DIR = process.env.ANHE_CLAUDE_WEB_HOME
  ? process.env.ANHE_CLAUDE_WEB_HOME
  : join(homedir(), ".anhe-claude-web");

/** 项目记录（JSON，原子写）。 */
export const STORE_FILE = join(DATA_DIR, "store.json");

/**
 * HTTP 端口。
 *
 * 开发模式下这里只有 API —— Vite 占着浏览器那侧（5519），把 `/api` 反代到这里。
 * 发布版同一个服务同时回答前端与 API，所以这就是你打开的地址。
 *
 * 默认值实际来自两处：`cli/bin.js` 会显式传 `--port`（默认 5419），
 * 所以发布版永远是 5419。下面这个 4419 只在「直接跑 `tsx src/index.ts`」时生效，
 * 也就是 `pnpm dev` 的后端那一侧；`web/vite.config.ts` 的代理目标跟着它走。
 *
 * 两个数字不同是故意的：开发时不该占用发布版端口，否则本地装过全局包的人
 * 一跑 `pnpm dev` 就会撞端口。
 */
export const PORT = Number(process.env.ANHE_CLAUDE_WEB_PORT ?? 4419);

/** 监听地址。默认只对本机，见 SECURITY.md。 */
export const HOST = process.env.ANHE_CLAUDE_WEB_HOST ?? "127.0.0.1";

/** 会话进程多久没活动就回收。 */
export const IDLE_TIMEOUT_MS = Number(process.env.ANHE_CLAUDE_WEB_IDLE_MS ?? 10 * 60 * 1000);

/** 同时存活的 claude 子进程上限。 */
export const MAX_ACTIVE_SESSIONS = Number(process.env.ANHE_CLAUDE_WEB_MAX_SESSIONS ?? 8);

/**
 * 一条 SSE 连接在 socket 堵住时最多能缓冲多少。
 *
 * `res.write` 返回 false 说明 Node 自己的缓冲满了 —— 客户端没跟上。继续硬写就是让
 * 一条卡住的流无限增长。超过这个字节数直接断开这条连接；浏览器会重连并重新拉一份
 * 权威快照。
 */
export const SSE_MAX_BUFFERED_BYTES = Number(
  process.env.ANHE_CLAUDE_WEB_SSE_BUFFER ?? 4 * 1024 * 1024,
);

/**
 * 覆盖 Claude Code 的会话根目录（`~/.claude/projects`）。
 *
 * 只给测试与验收用：让验收脚本不去碰用户真实的会话历史。
 */
export const SESSION_DIR_OVERRIDE = process.env.ANHE_CLAUDE_WEB_SESSION_DIR ?? null;

/**
 * 一个正整数环境变量，或默认值。
 *
 * 与上面的端口和超时不同，这里的坏值不会响：NaN 的字节预算会把每个标题裁成空。
 * 所以坏值回退默认，而不是让一个 typo 清空侧边栏。
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 一个会话标题的 UTF-8 字节预算。 */
export const TITLE_MAX_BYTES = positiveInt(process.env.ANHE_CLAUDE_WEB_TITLE_BYTES, 120);

/** 从首条消息推导标题时保留的词数。 */
export const TITLE_FALLBACK_WORDS = positiveInt(process.env.ANHE_CLAUDE_WEB_TITLE_WORDS, 8);

/**
 * 模型生成标题的预算。三个都要有，因为这个功能按次计费，每一维都必须小：
 * 短截止（标题不值得等）、小输入（首条消息可能是整个文件）、极小输出上限。
 */
export const TITLE_TIMEOUT_MS = positiveInt(process.env.ANHE_CLAUDE_WEB_TITLE_TIMEOUT_MS, 10_000);

/** 送给标题模型的首条消息字节数。 */
export const TITLE_INPUT_MAX_BYTES = positiveInt(process.env.ANHE_CLAUDE_WEB_TITLE_INPUT_BYTES, 2_000);

/** 一个标题的输出 token 上限。标题就一行，32 已经很宽松。 */
export const TITLE_OUTPUT_TOKENS = positiveInt(process.env.ANHE_CLAUDE_WEB_TITLE_OUTPUT_TOKENS, 32);

/**
 * 设为 1 时跳过一次性迁移：把旧 build 存在 `store.json` 里的名字搬到会话自己的文件里。
 */
export const SKIP_TITLE_MIGRATION = process.env.ANHE_CLAUDE_WEB_SKIP_TITLE_MIGRATION === "1";

/**
 * 一个解析为「空项目作用域」的 cwd。
 *
 * 设置页可以在没选工作区时打开，但项目级配置挂在 `<cwd>/` 下 —— 这里给一个
 * 永远不存在、也不会被创建的路径，读它的人自然拿到空作用域。
 * 每次调用都重新解析（验收脚本会重定向数据目录）。
 */
export function noProjectCwd(): string {
  return join(DATA_DIR, "no-project");
}

/**
 * 要托管的前端构建产物，没有则 null。
 *
 * `web/dist` 在两种布局下都位于上两级 —— `server/src/`（tsx 下）与
 * `server/build/`（发布包内）—— 所以一个相对路径同时覆盖开发和安装后的 CLI。
 *
 * null 是一个刻意的答案而不是错误：没构建的 checkout 仍然有一个能用的 API，
 * 而不是什么都不提供；启动日志会说清楚你拿到的是哪一种。
 * `ANHE_CLAUDE_WEB_STATIC_DIR` 覆盖这个查找，空值强制只跑 API。
 */
export const STATIC_DIR: string | null = (() => {
  const override = process.env.ANHE_CLAUDE_WEB_STATIC_DIR;
  if (override !== undefined) {
    return override.length > 0 ? resolve(override) : null;
  }
  const built = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return existsSync(join(built, "index.html")) ? built : null;
})();

/**
 * 服务开始监听后打开浏览器。
 *
 * 只有发布版 CLI 会打开它（它设 `ANHE_CLAUDE_WEB_OPEN=1`）：开发服务器不该抢
 * 编辑器的焦点，验收跑更不该弹窗。
 */
export const OPEN_BROWSER = process.env.ANHE_CLAUDE_WEB_OPEN === "1";
