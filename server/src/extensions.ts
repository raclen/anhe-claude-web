import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Claude Code 的扩展：skills、plugins、agents。
 *
 * **第一版只读。** 要启用/禁用/安装，去终端里用 `/plugin`、`/config`，或者直接改
 * `~/.claude/settings.json`。理由与 MCP 那一节相同：这些文件的 schema 是 Claude Code
 * 的私有实现细节，没有公开契约；用 UI 写进去等于在一个随时会变的格式上做双写，
 * 迟早写坏用户的配置。只读展示是能长期正确的答案。
 *
 * 数据来源：
 * - `~/.claude/skills/*`           用户级技能（每个目录一个 SKILL.md）
 * - `~/.claude/plugins/*`          用户级插件
 * - `~/.claude/agents/*`           用户级子代理
 * - `~/.claude/settings.json`      的 `enabledPlugins` / `skills` 等开关
 * - `<project>/.claude/skills` 等 项目级同名位置
 */

export type ExtensionKind = "skill" | "plugin" | "agent";

export interface ExtensionItem {
  /** 稳定标识：`kind:scope:name`。 */
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string | null;
  scope: "user" | "project";
  /** 目录或文件路径，用于设置页展示来源。 */
  path: string;
  /** 是否启用。无法判断时为 null（不是 false —— 别把「不知道」说成「关闭」）。 */
  enabled: boolean | null;
  /** 版本，插件才有。 */
  version: string | null;
}

export interface ExtensionsView {
  items: ExtensionItem[];
  /** 读不出来的路径与原因，展示在设置页里而不是吞掉。 */
  errors: Array<{ path: string; message: string }>;
  /** 本版只读，前端据此禁用开关。 */
  readOnly: true;
}

export class ExtensionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionConfigError";
  }
}

function claudeHome(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), ".claude");
}

/** 读一个目录下所有子目录名，不存在则空。 */
async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 从 SKILL.md 的 frontmatter 里抠 `description`。 */
function frontmatterDescription(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  const body = match[1] ?? "";
  const line = /^description:\s*(.+)$/m.exec(body);
  if (line === null) return null;
  return line[1]!.trim().replace(/^["']|["']$/g, "");
}

/** 读一个技能目录。 */
async function readSkill(
  skillDir: string,
  scope: "user" | "project",
): Promise<ExtensionItem | null> {
  const name = basename(skillDir);
  try {
    const skillFile = join(skillDir, "SKILL.md");
    const info = await stat(skillFile);
    if (!info.isFile()) return null;
    const text = await readFile(skillFile, "utf8");
    return {
      id: `skill:${scope}:${name}`,
      kind: "skill",
      name,
      description: frontmatterDescription(text),
      scope,
      path: skillDir,
      enabled: true,
      version: null,
    };
  } catch {
    return null;
  }
}

/** 读一个插件目录的 manifest。 */
async function readPlugin(
  pluginDir: string,
  scope: "user" | "project",
): Promise<ExtensionItem | null> {
  const name = basename(pluginDir);
  for (const manifestName of ["plugin.json", ".claude-plugin/plugin.json", "package.json"]) {
    try {
      const raw = await readFile(join(pluginDir, manifestName), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        id: `plugin:${scope}:${name}`,
        kind: "plugin",
        name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : name,
        description: typeof parsed.description === "string" ? parsed.description : null,
        scope,
        path: pluginDir,
        enabled: null,
        version: typeof parsed.version === "string" ? parsed.version : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** 读一个 agent 定义（`<name>.md`）。 */
async function readAgent(
  agentFile: string,
  scope: "user" | "project",
): Promise<ExtensionItem | null> {
  const name = basename(agentFile).replace(/\.md$/, "");
  try {
    const text = await readFile(agentFile, "utf8");
    return {
      id: `agent:${scope}:${name}`,
      kind: "agent",
      name,
      description: frontmatterDescription(text),
      scope,
      path: agentFile,
      enabled: true,
      version: null,
    };
  } catch {
    return null;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * 读所有扩展。
 *
 * `projectPath` 为 null 时只报用户级的。项目级的位置跟着项目走，
 * 没选项目就没有项目级扩展可言。
 */
export async function readExtensions(projectPath: string | null): Promise<ExtensionsView> {
  const items: ExtensionItem[] = [];
  const errors: ExtensionsView["errors"] = [];
  const home = claudeHome();

  const scopes: Array<{ scope: "user" | "project"; root: string }> = [
    { scope: "user", root: home },
  ];
  if (projectPath !== null) {
    scopes.push({ scope: "project", root: join(projectPath, ".claude") });
  }

  for (const { scope, root } of scopes) {
    for (const name of await listDirs(join(root, "skills"))) {
      const item = await readSkill(join(root, "skills", name), scope);
      if (item !== null) items.push(item);
    }
    for (const name of await listDirs(join(root, "plugins"))) {
      const item = await readPlugin(join(root, "plugins", name), scope);
      if (item !== null) items.push(item);
    }
    for (const file of await listMarkdownFiles(join(root, "agents"))) {
      const item = await readAgent(file, scope);
      if (item !== null) items.push(item);
    }
  }

  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { items, errors, readOnly: true };
}

/**
 * 第一版不支持改开关。
 *
 * 保留这个函数形状（与 pi-web 的路由对齐），但**明确抛错**而不是静默失败 ——
 * 前端会把它展示成「本版只读，请到设置页或终端里改」。
 */
export async function setExtensionEnabled(_input: {
  id: string;
  enabled: boolean;
}): Promise<ExtensionsView> {
  throw new ExtensionConfigError(
    "本版不写入 Claude Code 的配置。请用终端里的 /plugin 或 /config，或直接编辑 ~/.claude/settings.json。",
  );
}

/** 第一版不支持安装。 */
export async function installPackage(_source: string): Promise<void> {
  throw new ExtensionConfigError(
    "本版不支持安装扩展。请用终端里的 /plugin install，或按 Claude Code 文档手工安装。",
  );
}
