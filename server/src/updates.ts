import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 更新提示：本机装的 anhe-claude-web 是不是落后于 npm 上最新发布的版本。
 *
 * 与 pi-web 的差异：那边有两个概念（pi 自己 + pi 扩展包）。本项目**没有扩展**
 * —— 技能、插件、MCP 全归 Claude Code 管，本项目只读展示。所以这里只查一件事：
 * 这个 npm 包自己有没有新版本。
 *
 * 查的是 npm registry 的 `latest` dist-tag，不是自建端点 —— 因为没有自建端点。
 */

const REGISTRY_URL = "https://registry.npmjs.org/anhe-claude-web/latest";
const VERSION_CHECK_TIMEOUT_MS = 10 * 1000;

/** 已解析的答案复用的时长。 */
export const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000;

/** 本包的名字。换名字时这里和 `package.json` 一起改。 */
const PACKAGE_NAME = "anhe-claude-web";

/** 升级命令。显示在提示旁边。 */
const UPDATE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest`;

export interface VersionInfo {
  /** 当前运行的版本。 */
  current: string;
  /** npm 上的最新版本；查不到则 null。 */
  latest: string | null;
  /** 是否有新版本。 */
  available: boolean;
  /** 端点附带的说明（npm 一般没有）。 */
  note: string | null;
  /** 升级命令。 */
  updateCommand: string;
  /**
   * 为什么没查到。与 `available: false` 分开：
   * 「查不到」和「已经是最新」不是同一个事实，只有后者是好消息。
   */
  error: string | null;
  /** 因为离线/显式要求而跳过。 */
  skipped: boolean;
}

export interface UpdatesView {
  self: VersionInfo;
  /** 什么时候解析的（epoch ms），页面据此显示「x 分钟前」。 */
  checkedAt: number;
}

export interface UpdatesDeps {
  /** 默认用全局 fetch；测试替换它，保证不走网络。 */
  fetchImpl?: typeof fetch;
}

// --- 版本比较 ---------------------------------------------------------------

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** `candidate` 是否比 `current` 新。解析不出来时返回 false（保守：不误报）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // 正式版比同号的预发布版新。
  if (a.prerelease === null && b.prerelease !== null) return true;
  if (a.prerelease !== null && b.prerelease === null) return false;
  return false;
}

// --- 当前版本 ---------------------------------------------------------------

let cachedCurrent: string | null = null;

/**
 * 本包自己的版本号。
 *
 * 从 `package.json` 读，而不是从构建时注入的常量 —— 这样 `npm i -g` 之后
 * 版本永远与磁盘上的一致，不需要重新构建。
 */
export async function currentVersion(): Promise<string> {
  if (cachedCurrent !== null) return cachedCurrent;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // `server/build/updates.js` → 上两级是包根。
    const raw = await readFile(join(here, "..", "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedCurrent = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cachedCurrent = "0.0.0";
  }
  return cachedCurrent;
}

// --- 网络 -------------------------------------------------------------------

/** `ANHE_CLAUDE_WEB_OFFLINE=1` 或 `ANHE_CLAUDE_WEB_SKIP_VERSION_CHECK=1` 时跳过。 */
function versionCheckSkipped(): boolean {
  return (
    process.env.ANHE_CLAUDE_WEB_OFFLINE === "1" ||
    process.env.ANHE_CLAUDE_WEB_SKIP_VERSION_CHECK === "1"
  );
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `请求超时（${Math.round(VERSION_CHECK_TIMEOUT_MS / 1000)} 秒）。`;
    }
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      return "无法解析 registry.npmjs.org，检查网络或 DNS。";
    }
    if (cause?.code === "ECONNREFUSED") return "连接被拒绝，可能有代理拦截。";
    return error.message;
  }
  return String(error);
}

async function fetchLatestVersion(
  fetchImpl: typeof fetch,
): Promise<{ version: string; note: string | null } | null> {
  const response = await fetchImpl(REGISTRY_URL, {
    headers: {
      // npm registry 要求 UA 才回 JSON。
      Accept: "application/json",
      "User-Agent": `${PACKAGE_NAME} version-check`,
    },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  // 404 = 这个包还没发布过（开发期就是这样）。不是错误，是「查不到」。
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`registry 返回 ${response.status}`);

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.version !== "string" || data.version.trim().length === 0) return null;
  return {
    version: data.version.trim(),
    note: typeof data.description === "string" ? data.description : null,
  };
}

/** 解析版本提示。永不抛；失败落在 `error` 里。 */
async function readVersionInfo(deps: UpdatesDeps): Promise<VersionInfo> {
  const current = await currentVersion();
  const base = {
    current,
    latest: null,
    available: false,
    note: null,
    updateCommand: UPDATE_COMMAND,
  } satisfies Omit<VersionInfo, "error" | "skipped">;

  if (versionCheckSkipped()) {
    return { ...base, error: null, skipped: true };
  }

  try {
    const release = await fetchLatestVersion(deps.fetchImpl ?? fetch);
    if (release === null) {
      return { ...base, error: "npm registry 上没有这个包的发布记录。", skipped: false };
    }
    return {
      ...base,
      latest: release.version,
      available: isNewerVersion(release.version, current),
      note: release.note,
      error: null,
      skipped: false,
    };
  } catch (error) {
    return { ...base, error: describeFetchError(error), skipped: false };
  }
}

// --- 对外 -------------------------------------------------------------------

interface CacheEntry {
  view: UpdatesView;
  at: number;
}

let cache: CacheEntry | null = null;

/** 查一次更新状态。`force` 绕过缓存（设置页的「重新检查」）。 */
export async function readUpdates(deps: UpdatesDeps = {}, force = false): Promise<UpdatesView> {
  if (!force && cache !== null && Date.now() - cache.at < UPDATE_CACHE_TTL_MS) {
    return cache.view;
  }
  const self = await readVersionInfo(deps);
  const view: UpdatesView = { self, checkedAt: Date.now() };
  cache = { view, at: Date.now() };
  return view;
}

/** 清掉缓存。 */
export function invalidateUpdatesCache(): void {
  cache = null;
}
