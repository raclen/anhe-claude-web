import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 定位本机已安装的 Claude Code 可执行文件。
 *
 * 为什么这不是 `spawn("claude")` 就完事：
 * npm 全局装的 `claude` 在 Windows 上是三个 shim（无扩展名的 bash 脚本、`.cmd`、`.ps1`），
 * Node 22 直接 spawn 会报 `ENOENT (errno -4058)` —— 实测过。
 * 真正的 PE 在 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`。
 *
 * 所以这里按顺序找一个**能直接执行**的东西，并且用 `--version` 验一次，
 * 再把版本号报给前端。找不到时给一条可操作的安装提示，而不是让用户在发第一条
 * 消息时才看到一个 ENOENT。
 */
export interface ClaudeCli {
  /** 可以直接交给 spawn 的可执行文件路径。 */
  path: string;
  /** `claude --version` 的原始输出，去掉换行。 */
  version: string;
  /** 从 version 里解析出的语义化版本号，解析不出则 null。 */
  semver: string | null;
  /** 从哪条规则找到的，用于设置页展示与排障。 */
  source: "env" | "npm-global-bin" | "npm-prefix" | "path" | "posix-path" | "cmd-shim";
  /** true 表示必须经 shell 执行（`.cmd` / `.ps1` shim）。 */
  needsShell: boolean;
}

export type LocateFailure = {
  ok: false;
  /** 给用户看的短句。 */
  message: string;
  /** 逐条说明试过什么，展示在设置页里。 */
  attempts: string[];
};

export type LocateResult = { ok: true; cli: ClaudeCli } | LocateFailure;

const IS_WINDOWS = process.platform === "win32";

/** 从 `2.1.309 (Claude Code)` 里抠出版本号。 */
export function parseVersion(raw: string): string | null {
  const match = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1]! : null;
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // Windows 上没有可执行位，statSync 通过就够；POSIX 上要 X_OK。
    if (!IS_WINDOWS) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** npm 全局 `node_modules` 的候选位置，按可信度排序。 */
function npmGlobalRoots(): string[] {
  const roots: string[] = [];
  const appData = process.env.APPDATA;
  if (IS_WINDOWS && appData) roots.push(join(appData, "npm", "node_modules"));
  const prefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX;
  if (prefix) roots.push(join(prefix, "node_modules"));
  // POSIX 常见布局，也覆盖 nvm / Homebrew 的部分情况。
  roots.push(join(homedir(), ".npm-global", "lib", "node_modules"));
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  return roots;
}

/** PATH 上所有 `claude*` 候选，按 PATH 顺序。 */
function pathCandidates(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const dirs = raw.split(delimiter).filter((dir) => dir.length > 0);
  const names = IS_WINDOWS
    ? ["claude.exe", "claude.cmd", "claude.ps1", "claude"]
    : ["claude"];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) out.push(join(dir, name));
  }
  return out;
}

interface Candidate {
  path: string;
  source: ClaudeCli["source"];
  needsShell: boolean;
}

function collectCandidates(): { candidates: Candidate[]; attempts: string[] } {
  const candidates: Candidate[] = [];
  const attempts: string[] = [];
  const seen = new Set<string>();

  const push = (path: string, source: ClaudeCli["source"], needsShell = false) => {
    const key = IS_WINDOWS ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: resolve(path), source, needsShell });
  };

  // 1. 用户显式指定，最高优先级。
  const envPath = process.env.CLAUDE_CODE_PATH;
  if (envPath && envPath.length > 0) {
    attempts.push(`CLAUDE_CODE_PATH=${envPath}`);
    push(envPath, "env", IS_WINDOWS && /\.(cmd|ps1)$/i.test(envPath));
  } else {
    attempts.push("CLAUDE_CODE_PATH 未设置");
  }

  // 2. npm 全局包里的原生二进制。这是 Windows 上唯一「直接可执行」的那个。
  const exeName = IS_WINDOWS ? "claude.exe" : "claude";
  for (const root of npmGlobalRoots()) {
    const bin = join(root, "@anthropic-ai", "claude-code", "bin", exeName);
    attempts.push(bin);
    push(bin, "npm-global-bin");
  }
  // 3. npm 前缀目录下直接放的 shim（`%APPDATA%\npm\claude.exe`）。
  if (IS_WINDOWS && process.env.APPDATA) {
    const direct = join(process.env.APPDATA, "npm", exeName);
    attempts.push(direct);
    push(direct, "npm-prefix");
  }

  // 4/5. PATH。
  for (const candidate of pathCandidates()) {
    push(candidate, IS_WINDOWS ? "path" : "posix-path", /\.(cmd|ps1)$/i.test(candidate));
  }
  attempts.push("PATH 上的 claude(.exe|.cmd|.ps1)");

  return { candidates, attempts };
}

/**
 * 跑一次 `--version`。
 *
 * Windows 上 `execFile` 不能直接执行 `.cmd`，所以带 shell 的候选走 shell。
 * 超时 15 秒：实测原生 exe 的 `--version` 约 300ms，但杀软扫描首启可能到数秒。
 */
async function probeVersion(candidate: Candidate): Promise<string | null> {
  try {
    const { stdout } = candidate.needsShell
      ? await execFileAsync(`"${candidate.path}" --version`, {
          shell: true,
          timeout: 15_000,
          windowsHide: true,
        })
      : await execFileAsync(candidate.path, ["--version"], {
          timeout: 15_000,
          windowsHide: true,
        });
    const text = stdout.trim();
    return text.length > 0 ? text.split(/\r?\n/)[0]! : null;
  } catch {
    return null;
  }
}

/** 定位结果缓存。探测含子进程调用，不要每次请求都重跑。 */
let cached: LocateResult | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

/** 清掉缓存。安装/升级 Claude Code 之后调用一次。 */
export function invalidateClaudeCliCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

/**
 * 找到可用的 Claude Code。结果缓存 30 秒。
 *
 * 找不到时返回 `ok: false` 而不是抛异常 —— 前端的首屏要能展示这条失败信息，
 * 而不是拿到一个 500。
 */
export async function locateClaudeCli(): Promise<LocateResult> {
  if (cached && Date.now() < cacheExpiresAt) return cached;

  const { candidates, attempts } = collectCandidates();
  const executable = candidates.filter((candidate) => isExecutableFile(candidate.path));

  if (executable.length === 0) {
    const result: LocateFailure = {
      ok: false,
      message:
        "没有找到 Claude Code。请先安装：npm i -g @anthropic-ai/claude-code，" +
        "或用 CLAUDE_CODE_PATH 指定可执行文件路径。",
      attempts,
    };
    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  }

  for (const candidate of executable) {
    const version = await probeVersion(candidate);
    if (version === null) {
      attempts.push(`${candidate.path} → --version 失败`);
      continue;
    }
    const result: LocateResult = {
      ok: true,
      cli: {
        path: candidate.path,
        version,
        semver: parseVersion(version),
        source: candidate.source,
        needsShell: candidate.needsShell,
      },
    };
    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  }

  const result: LocateFailure = {
    ok: false,
    message:
      "找到了 Claude Code 但 `claude --version` 执行失败。可能是权限问题，或安装已损坏：" +
      "试试重新安装 npm i -g @anthropic-ai/claude-code。",
    attempts,
  };
  cached = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return result;
}

/**
 * 同步判断某个路径是否像一份可用的 CLI 安装。
 *
 * 只给启动日志用：不想为了打一行日志去 await 一个子进程。
 */
export function looksInstalled(path: string): boolean {
  return existsSync(path);
}
