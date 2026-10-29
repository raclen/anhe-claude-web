import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { wantsFrame, type EventBus } from "./bus.ts";
import { BUILTIN_COMMANDS, runBuiltinCommand } from "./commands.ts";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import type { StaticHandler } from "./static.ts";
import {
  ExtensionConfigError,
  readExtensions,
  setExtensionEnabled,
} from "./extensions.ts";
import {
  readUpdates,
} from "./updates.ts";
import {
  McpConfigError,
  deleteMcpServer,
  probeMcpServer,
  readMcp,
  saveMcpServer,
  setMcpServerEnabled,
} from "./mcp.ts";
import { listDirectories, startLocations } from "./fs-browse.ts";
import {
  GitError,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitPush,
  gitStage,
  gitStageAll,
  readGitStatus,
} from "./git.ts";
import {
  readWorkspaceFile,
  readWorkspaceRaw,
  readWorkspaceTextPage,
  listWorkspaceDirectory,
} from "./workspace-files.ts";
import { TerminalManager, type TerminalHost } from "./terminal.ts";
import { pendingUiRequests, type PendingUiRequests } from "./ui-requests.ts";
import {
  readComposerFromDefaults,
  readComposerFromDisk,
  readComposerFromHandle,
  type ComposerState,
} from "./composer.ts";
import {
  API_PROTOCOLS,
  KNOWN_PROVIDERS,
  ModelConfigError,
  authPath,
  deleteProvider,
  fetchProviderModels,
  modelsPath,
  readProviders,
  saveProvider,
  type ProviderModelEntry,
} from "./models.ts";
import {
  addProject,
  getProject,
  listProjects,
  ProjectError,
  removeProject,
  renameProject,
  reorderProjects,
  setSessionOverride,
} from "./projects.ts";
import {
  type PermissionMode,
  type SessionHandle,
  type SessionRegistry,
  type SlashCommand,
} from "./registry.ts";
import { PERMISSION_MODES } from "./agent/controls.ts";
import { locateClaudeCli } from "./agent/locate.ts";
import { configSummary, listModels, readSettings } from "./agent/models.ts";
import { deleteSession } from "./session-delete.ts";
import {
  assertAllowedSessionPath,
  draftProjectPath,
  getSessionRoot,
  isDraftPath,
  makeDraftPath,
  sessionDirFor,
} from "./session-path.ts";
import { readSessionSnapshot } from "./session-reader.ts";
import { listSessions } from "./sessions.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  mutateStore,
  readStore,
  type AppearancePreference,
  type BusySendBehavior,
  type LanguagePreference,
  type TitleModelChoice,
  type TranscriptDisplay,
} from "./store.ts";
import { SSE_MAX_BUFFERED_BYTES } from "./config.ts";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export interface RouteDeps {
  registry: SessionRegistry;
  bus: EventBus;
  /** Directory the API is allowed to open sessions from. Defaults to pi's store. */
  sessionRoot?: string;
  /** Blocking extension dialogs. Defaults to the process-wide table. */
  uiRequests?: PendingUiRequests;
  /**
   * Serves the built front end for everything outside `/api`. Null (or
   * omitted) leaves the server API-only, which is what the dev setup wants:
   * Vite owns the browser-facing port there and proxies `/api` here.
   */
  staticHandler?: StaticHandler | null;
  /**
   * Bytes one SSE connection may buffer before it is dropped. Defaults to
   * `SSE_MAX_BUFFERED_BYTES`; tests lower it to reach the limit in a few writes.
   */
  sseMaxBufferedBytes?: number;
  /**
   * The shells behind `/api/terminal`. Defaults to a manager owned by this
   * handler, which is what the server and every test want: one handler means
   * one set of shells, torn down with it. A test supplies a stand-in when it
   * cares about which shell the routes ask for rather than about the shell.
   */
  terminals?: TerminalHost;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid JSON body");
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

/** Narrow a patch field to one of its allowed literals, or reject the write. */
function requireChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Out-of-range font sizes are rejected rather than clamped. A settings field
 * that quietly stores a different number than the one that was typed is worse
 * than one that refuses the write, and the UI never offers an invalid value in
 * the first place. Bounds mirror dsh's theme schema (12..17).
 */
function requireFontSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < FONT_SIZE_MIN ||
    value > FONT_SIZE_MAX
  ) {
    throw badRequest(
      `contentFontSize must be an integer between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}`,
    );
  }
  return value;
}

/**
 * The title model is either `null` — nobody writes titles — or a provider/model
 * pair. Only the shape is checked here: whether that provider still exists is a
 * question for the call itself, which answers it by leaving the deterministic
 * title in place.
 */
function requireTitleModel(value: unknown): TitleModelChoice | null {
  if (value === null) return null;
  const candidate = value as { provider?: unknown; model?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null) {
    throw badRequest("titleModel must be null or { provider, model }");
  }
  const { provider, model } = candidate;
  if (typeof provider !== "string" || provider.length === 0
    || typeof model !== "string" || model.length === 0) {
    throw badRequest("titleModel must be null or { provider, model }");
  }
  return { provider, model };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${key} is required`);
  }
  return value;
}

/**
 * A finite number from the request body.
 *
 * Bounds are not checked here — `TerminalManager` clamps to what a PTY can
 * actually hold, and doing it in two places would mean two answers.
 */
function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${key} must be a number`);
  }
  return value;
}

/**
 * The model a new session should start on, as the hero's picker sends it.
 *
 * Absent means "whatever pi starts on" — the field is only sent when the user
 * picked something other than the default, and a missing one must not be read
 * as a request for the first available model. A present but malformed value is
 * a caller mistake and is rejected rather than silently ignored.
 */
function optionalModel(body: Record<string, unknown>): { provider: string; id: string } | null {
  const value = body.model;
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw badRequest("model must be an object");
  const { provider, id } = value;
  if (typeof provider !== "string" || provider.length === 0) {
    throw badRequest("model.provider is required");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw badRequest("model.id is required");
  }
  return { provider, id };
}

/**
 * The formats a provider will actually decode. The same list the composer
 * enforces, repeated here because the two ends are separately reachable: a
 * curl or an extension can post a prompt without going through the input bar.
 */
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Ceiling per image, in encoded characters: 4/3 of 5MB plus padding. */
const MAX_IMAGE_CHARS = Math.ceil((5 * 1024 * 1024 * 4) / 3);

/** How many images one message may carry. Mirrors the composer's own limit. */
const MAX_IMAGES_PER_MESSAGE = 8;

/**
 * pi's `ImageContent`, spelled out: `@earendil-works/pi-coding-agent` does not
 * re-export the type, and the RPC client takes it structurally anyway.
 */
interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * The images riding along with a message, or undefined when there are none.
 *
 * This is the only place the shape is checked before it is forwarded verbatim to
 * a running pi. A malformed block would otherwise fail somewhere inside a
 * provider request — after a spawn, with an error that names the model rather
 * than the request — and the limits are the ones the composer already holds the
 * user to, so a rejection here is always something the UI could not have sent.
 */
function parseImages(body: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = body.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest("images must be an array");
  if (value.length === 0) return undefined;
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    throw badRequest(`最多 ${String(MAX_IMAGES_PER_MESSAGE)} 张图片`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw badRequest(`images[${String(index)}] must be an object`);
    }
    const { data, mimeType } = entry as { data?: unknown; mimeType?: unknown };
    if (typeof data !== "string" || data.length === 0) {
      throw badRequest(`images[${String(index)}].data is required`);
    }
    if (data.length > MAX_IMAGE_CHARS) {
      throw badRequest(`images[${String(index)}] 超过 5MB`);
    }
    if (typeof mimeType !== "string" || !ACCEPTED_IMAGE_TYPES.has(mimeType)) {
      throw badRequest(`images[${String(index)}].mimeType 不受支持`);
    }
    return { type: "image", data, mimeType };
  });
}

/**
 * A message that is allowed to be empty — as long as a picture came with it.
 *
 * pi writes the same `[{ type: "text", text }, ...images]` content either way,
 * so a screenshot with no caption is a complete message; requiring text would
 * turn a legitimate turn into a 400 the composer cannot explain.
 */
function messageWithImages(body: Record<string, unknown>): {
  message: string;
  images: ImageAttachment[] | undefined;
} {
  const message = optionalString(body, "message") ?? "";
  const images = parseImages(body);
  if (message.length === 0 && images === undefined) {
    throw badRequest("message or images is required");
  }
  return { message, images };
}

/**
 * A field the editor may omit. Absent means "leave the stored value alone",
 * which is what lets a save that did not retype the API key preserve it.
 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string`);
  return value;
}

/**
 * A count from the query string, or undefined when it is missing or nonsense.
 *
 * A page size is a rendering hint, not a constraint on the data: a client that
 * asks for something unusable gets the default view rather than a 400.
 */
function optionalPositiveInt(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The workspace a settings request is about, or null for the user scope.
 *
 * `null` and the empty string both mean "no workspace": the settings page sends
 * null before one is selected, and an empty query parameter is what a missing
 * value looks like on the wire.
 */
function optionalProjectPath(body: Record<string, unknown>): string | null {
  const value = body.projectPath;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("projectPath must be a string");
  return value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}





function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  // Bad provider configuration is the user's input being wrong, not the server
  // failing. "已有提供方使用了这个 ID" belongs in the form, at 400, not in the
  // error banner as a 500.
  if (err instanceof ModelConfigError) return badRequest(err.message);
  if (err instanceof ExtensionConfigError) return badRequest(err.message);
  if (err instanceof McpConfigError) return badRequest(err.message);
  // A git write that git itself refused — nothing staged, no identity, a
  // rejected push — is the user's action not landing, not the server breaking.
  // Its own message ("nothing to commit, working tree clean") is the message.
  if (err instanceof GitError) return badRequest(err.message);
  if (err instanceof ProjectError) {
    switch (err.code) {
      case "ENOENT":
      case "ENOTFOUND":
        return new HttpError(404, err.message);
      case "EEXIST":
        return new HttpError(409, err.message);
      default:
        return badRequest(err.message);
    }
  }
  const message = err instanceof Error ? err.message : "internal error";
  return new HttpError(500, message);
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Reject any request whose Host (or Origin, when present) is not loopback.
 *
 * This server has no authentication and can enumerate the filesystem, so a
 * page on the public internet must not be able to drive it. Under DNS
 * rebinding a malicious origin resolves to 127.0.0.1 but still sends its own
 * Host header, which this rejects.
 */
function assertLocalRequest(req: IncomingMessage): void {
  const host = req.headers.host ?? "";
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  if (!LOCAL_HOSTNAMES.has(hostname.toLowerCase())) {
    throw forbidden(`unexpected Host header: ${host || "(missing)"}`);
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname.toLowerCase();
    } catch {
      throw forbidden(`unparseable Origin: ${origin}`);
    }
    if (!LOCAL_HOSTNAMES.has(originHostname)) {
      throw forbidden(`unexpected Origin: ${origin}`);
    }
  }
}

/**
 * Builds the HTTP request handler for the API. Dependencies are injected so
 * tests can drive a stub pi process and a private storage root.
 */
/**
 * 一个会话 jsonl 里的 `cwd`。
 *
 * 项目归属的唯一权威来源。Claude Code 的目录 slug 不可反推，所以这里读文件而非
 * 从路径解码。
 */
async function sessionCwd(sessionPath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) return parsed.cwd;
      } catch {
        continue;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return "";
}

export function createRequestHandler(deps: RouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { registry, bus, staticHandler = null, sseMaxBufferedBytes = SSE_MAX_BUFFERED_BYTES } =
    deps;
  const sessionRoot = deps.sessionRoot ?? getSessionRoot();
  const uiRequests = deps.uiRequests ?? pendingUiRequests;
  const terminals = deps.terminals ?? new TerminalManager({ bus });
  const routes: Route[] = [];

  const route = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, segments: path.split("/").filter(Boolean), handler });
  };

  /**
   * 校验一个会话地址。
   *
   * draft（`draft:<项目路径>`）直接放行：那是一个还没落盘的新会话，没有文件可校验。
   * 其余一律必须在 `~/.claude/projects` 之内 —— 否则一个能访问本机服务端的页面
   * 就能让它把任意文件当会话打开。
   */
  const allowedPath = (raw: string): string =>
    isDraftPath(raw) ? raw : assertAllowedSessionPath(raw, sessionRoot);

  /**
   * Whether this id names a session file this process may read.
   *
   * Used where an unreadable path has a fallback rather than an error: the
   * question there is "is there something on disk?", not "is this allowed?".
   */
  const isSessionFile = (raw: string): boolean => {
    try {
      allowedPath(raw);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Attach to a session, spawning a pi process when none is live. Draft
   * sessions are already registered by path, so they resolve without disk I/O.
   */
  const openSession = async (sessionPath: string): Promise<SessionHandle> => {
    const live = registry.get(sessionPath);
    if (live && !live.dead) {
      registry.touch(sessionPath);
      return live;
    }

    // 新会话：还没有 jsonl，项目路径就写在 draft 键里。
    if (isDraftPath(sessionPath)) {
      // 复用已有的 draft 句柄，键必须和前端订阅的那个一模一样 ——
      // 否则前端收到的事件会话路径和它订阅的路径对不上，一条都收不到。
      const existing = registry.get(sessionPath);
      if (existing && !existing.dead) {
        registry.touch(sessionPath);
        return existing;
      }
      // 这个 draft 键可能已经「长大」成真实 jsonl 了（第一条消息发出去之后，
      // 句柄的键就迁到了 `<...>.jsonl`）。此时用户手里的 draft 路径仍然是有效的
      // 会话身份，要按项目路径把它找回来，不能当成新会话再开一个进程。
      const projectPath = draftProjectPath(sessionPath);
      const live = registry.findLive(projectPath);
      if (live !== undefined) {
        registry.touch(live.sessionPath);
        return live;
      }
      const handle = await registry.open(projectPath);
      // 重新按 draft 键登记，让 `handle.sessionPath` 在这里就等于前端手里的路径。
      registry.alias(handle, sessionPath);
      return handle;
    }

    // cwd 一律从 jsonl 行内读，不用目录名反推（slug 不可逆）。
    let cwd: string;
    try {
      cwd = await sessionCwd(sessionPath);
    } catch (err) {
      throw notFound(`无法打开会话：${(err as Error).message}`);
    }
    if (cwd.length === 0) throw notFound("会话里没有 cwd，无法确定项目目录");
    return registry.open(cwd, sessionPath);
  };

  /** Any RPC failure marks the handle dead so the next request respawns it. */
  const callClient = async <T>(handle: SessionHandle, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      registry.touch(handle.sessionPath);
      return result;
    } catch (err) {
      // An HttpError raised by the handler itself is a caller mistake — an
      // unknown command name, say — not a broken process. Killing a healthy pi
      // process over a typo would cost a 1.6s respawn on the next request.
      if (err instanceof HttpError) throw err;
      registry.markDead(handle.sessionPath);
      throw new HttpError(502, `pi rpc failed: ${(err as Error).message}`);
    }
  };

  /**
   * Composer state from a resident process.
   *
   * The runtime answers with the model's window but not its display name —
   * names live in `models.json` — so the on-disk catalog rides along and fills
   * that in. Reading it is a few hundred bytes next to the RPCs already in
   * flight, and the alternative is showing raw model ids where the settings page
   * shows names.
   */
  const liveComposer = async (handle: SessionHandle): Promise<ComposerState> => {
    return await readComposerFromHandle(handle);
  };

  /**
   * Composer state from the session file, with a missing session reported as
   * 404 and a broken `models.json` left to bubble up as the 400 it is.
   */
  const diskComposer = async (sessionPath: string): Promise<ComposerState> => {
    try {
      return await readComposerFromDisk(sessionPath);
    } catch (err) {
      throw notFound(`无法读取会话：${(err as Error).message}`);
    }
  };

  /**
   * Apply the hero's model choice to a session that was just created.
   *
   * A failure is reported in the response rather than thrown: the session
   * already exists, and discarding it because one id had gone stale would cost
   * the user the draft they were about to type into. The picker only offers ids
   * pi listed a moment ago, so the failing path is "the model was removed
   * between the two reads", not "the client sent something wrong".
   */
  const applyModel = async (
    handle: SessionHandle,
    model: { provider: string; id: string } | null,
  ): Promise<{ modelError?: string }> => {
    if (model === null) return {};
    try {
      await handle.client.setModel(model.provider, model.id);
      registry.touch(handle.sessionPath);
      return {};
    } catch (err) {
      return {
        modelError: `无法切换到 ${model.provider}/${model.id}：${(err as Error).message}`,
      };
    }
  };

  // --- health ---------------------------------------------------------------

  route("GET", "/api/health", ({ res }) => {
    json(res, 200, { ok: true, activeSessions: registry.list().length });
  });

  // --- host environment -----------------------------------------------------

  // The UI shortens absolute paths to `~/...`. Only the host knows where home
  // is, and guessing from a path prefix would be wrong on every other machine.
  route("GET", "/api/env", ({ res }) => {
    json(res, 200, { home: homedir() });
  });

  // --- settings -------------------------------------------------------------

  // Shell preferences owned by this UI end to end. They live in our own store
  // file rather than pi's config, because none of them has a pi-side
  // counterpart: changing how this page looks or how Enter behaves must never
  // change what the terminal does.
  route("GET", "/api/settings", async ({ res }) => {
    const store = await readStore();
    json(res, 200, store.settings);
  });

  route("PUT", "/api/settings", async ({ res, body }) => {
    const patch = asObject(body);
    const settings = await mutateStore((draft) => {
      const next = draft.settings;
      if (patch.appearance !== undefined) {
        next.appearance = requireChoice<AppearancePreference>(
          patch.appearance,
          ["light", "dark", "system"],
          "appearance",
        );
      }
      if (patch.language !== undefined) {
        next.language = requireChoice<LanguagePreference>(
          patch.language,
          ["system", "zh-CN", "en"],
          "language",
        );
      }
      if (patch.contentFontSize !== undefined) {
        next.contentFontSize = requireFontSize(patch.contentFontSize);
      }
      if (patch.transcriptDisplay !== undefined) {
        next.transcriptDisplay = requireChoice<TranscriptDisplay>(
          patch.transcriptDisplay,
          ["compact", "standard", "detailed", "verbose"],
          "transcriptDisplay",
        );
      }
      if (patch.busySendBehavior !== undefined) {
        next.busySendBehavior = requireChoice<BusySendBehavior>(
          patch.busySendBehavior,
          ["queue", "steer"],
          "busySendBehavior",
        );
      }
      if (patch.browserNotifications !== undefined) {
        if (typeof patch.browserNotifications !== "boolean") {
          throw badRequest("browserNotifications must be a boolean");
        }
        next.browserNotifications = patch.browserNotifications;
      }
      if (patch.titleModel !== undefined) {
        next.titleModel = requireTitleModel(patch.titleModel);
      }
      return next;
    });
    json(res, 200, settings);
  });

  // Agent behaviour that belongs to pi, not to us: read back from a live
  // process rather than mirrored, so the terminal and this page cannot
  // disagree. Split from `/api/settings` because it can wait on a cold start.
  const agentHandle = async (projectPath: string): Promise<SessionHandle | null> => {
    return registry.findLive(projectPath) ?? (await registry.ensurePrewarmed(projectPath));
  };

  route("GET", "/api/settings/agent", async ({ res, query }) => {
    const projectPath = query.get("projectPath") ?? "";
    const handle = projectPath.length > 0 ? await agentHandle(projectPath) : null;
    if (handle === null) {
      // Nothing to read from. The row renders as unavailable instead of
      // showing a value we invented, which the user would then "change" to
      // the value it already appeared to have.
      json(res, 200, { available: false });
      return;
    }
    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { available: true, autoCompaction: state.autoCompactionEnabled });
  });

  route("PUT", "/api/settings/agent", async ({ res, body }) => {
    const patch = asObject(body);
    const projectPath = requireString(patch, "projectPath");
    const handle = await agentHandle(projectPath);
    if (handle === null) throw new HttpError(503, "cannot start a pi process for this project");

    if (patch.autoCompaction !== undefined) {
      if (typeof patch.autoCompaction !== "boolean") {
        throw badRequest("autoCompaction must be a boolean");
      }
      await callClient(handle, () => handle.client.setAutoCompaction(patch.autoCompaction as boolean));
    }

    // pi persists this globally and only a freshly started process reads the
    // file back, so any other resident process would keep serving the value it
    // booted with. Retiring them costs one cold start on the next switch;
    // keeping them would show a stale setting in a session the user still has
    // open. `handle` itself already holds the new value.
    await registry.closeAllExcept(handle, "settings-changed");

    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { available: true, autoCompaction: state.autoCompactionEnabled });
  });

  // --- model providers ------------------------------------------------------

  // pi reads `models.json` and `auth.json` once at startup, so this page edits
  // the files — there is no RPC for provider definitions. One response carries
  // everything the page needs: the providers plus the catalog and protocol
  // values the editors offer. Both lists are pi's, not ours, so they ship with
  // the response instead of being duplicated in the frontend.
  const modelsView = async (): Promise<Record<string, unknown>> => ({
    providers: await readProviders(),
    modelsPath: modelsPath(),
    authPath: authPath(),
    knownProviders: [...KNOWN_PROVIDERS],
    apiProtocols: [...API_PROTOCOLS],
  });

  // Every write retires the resident pi processes. They read the provider list
  // when they started, so a process that predates the edit would keep serving
  // the old set — the provider just added would appear nowhere, and a deleted
  // one would still answer. Sessions live on disk, so the cost is one cold
  // start on the next switch rather than lost work.
  const finishModelWrite = async (res: ServerResponse, status: number): Promise<void> => {
    await registry.closeAllExcept(null, "model-config-changed");
    json(res, status, await modelsView());
  };

  route("GET", "/api/models/providers", async ({ res }) => {
    json(res, 200, await modelsView());
  });

  // 本版只读：provider 的增删改与「拉取模型列表」都不提供。
  // 见 models.ts 的文件头，以及 docs/known-limitations.md。
  const refuseWrite = (): never => {
    throw new ModelConfigError(
      "本版不写入模型配置。请编辑 ~/.claude/settings.json，或用终端里的 /config、/model。",
    );
  };

  route("POST", "/api/models/providers", () => refuseWrite());
  route("PUT", "/api/models/providers/:id", () => refuseWrite());
  route("DELETE", "/api/models/providers/:id", () => refuseWrite());
  route("POST", "/api/models/fetch-models", () => refuseWrite());

  // --- extensions -----------------------------------------------------------

  /**
   * Every extension pi would consider loading, resolved by pi's own package
   * manager against the settings and package files on disk.
   *
   * `projectPath` is optional: without it the answer covers the user scope only,
   * which is what the settings page asks for before a workspace is selected.
   * Resolution failures come back as `error` on a 200 rather than as an HTTP
   * error, because an empty list and a broken read are different states and the
   * page has to tell them apart.
   */
  route("GET", "/api/extensions", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readExtensions(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  /**
   * Turn one extension on or off, then answer with the full re-resolved list.
   *
   * The write lands in pi's settings file, and only a freshly started process
   * reads that file back — the same reason provider edits retire the resident
   * processes. Extensions are loaded at startup, so a process that predates
   * this change would keep running the old set; sessions live on disk, so the
   * cost is one cold start on the next switch.
   */
  route("PUT", "/api/extensions", async ({ res }) => {
    // 本版只读：扩展开关不写入 Claude Code 的配置。
    try {
      await setExtensionEnabled({ id: "", enabled: false });
    } catch (error) {
      if (error instanceof ExtensionConfigError) throw badRequest(error.message);
      throw error;
    }
    json(res, 200, await readExtensions(null));
  });

  // --- update notices -------------------------------------------------------

  /**
   * Whether a newer pi is published, and which installed packages are behind.
   *
   * `refresh=true` bypasses the server's short cache; the default read reuses
   * an answer from the last few minutes, so opening the settings page does not
   * spawn an `npm view` per package on every visit. A check that could not be
   * completed is reported inside the payload (`error`) rather than as an HTTP
   * error: "could not check" and "up to date" are different facts, and the page
   * renders them differently.
   */
  route("GET", "/api/updates", async ({ res, query }) => {
    json(res, 200, await readUpdates({}, query.get("refresh") === "true"));
  });

  route("POST", "/api/updates/extensions", () => {
    // 本项目没有可更新的扩展包：技能与插件由 Claude Code 自己管理。
    throw badRequest("本项目没有可更新的扩展包。请在终端里用 /plugin 管理技能与插件。");
  });

  // --- MCP servers（本版只读）------------------------------------------------

  /**
   * MCP 配置只读。
   *
   * 这些文件的 schema 是 Claude Code 的私有实现细节；用 UI 写进去等于在一个
   * 没有契约的格式上做双写。要增删改，用终端里的 `/mcp`，或直接编辑文件。
   * 见 `mcp.ts` 的文件头与 docs/known-limitations.md。
   */
  const refuseMcpWrite = (): never => {
    throw new McpConfigError(
      "本版不写入 MCP 配置。请用终端里的 /mcp，或直接编辑 ~/.claude.json / <项目>/.mcp.json。",
    );
  };

  /** MCP 清单：从 `~/.claude.json`、`~/.claude/settings.json`、`<项目>/.mcp.json` 读。 */
  route("GET", "/api/mcp", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readMcp(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  route("PUT", "/api/mcp/servers", () => refuseMcpWrite());
  route("DELETE", "/api/mcp/servers", () => refuseMcpWrite());
  route("PUT", "/api/mcp/state", () => refuseMcpWrite());
  route("POST", "/api/mcp/check", () => refuseMcpWrite());

  /**
   * Retire every resident pi process so the next message re-reads the MCP
   * config. This is dsh's 重启, narrowed to what this server can actually do:
   * sessions live on disk, so the cost is one cold start per session.
   */
  route("POST", "/api/mcp/restart", async ({ res }) => {
    const closed = registry.list().length;
    await registry.closeAllExcept(null, "mcp-restart");
    json(res, 200, { ok: true, closed });
  });

  // --- filesystem (directory picker) ---------------------------------------

  route("GET", "/api/fs/locations", async ({ res }) => {
    json(res, 200, await startLocations());
  });

  route("GET", "/api/fs/list", async ({ res, query }) => {
    json(res, 200, await listDirectories(query.get("path") ?? undefined));
  });

  // --- projects -------------------------------------------------------------

  route("GET", "/api/projects", async ({ res }) => {
    json(res, 200, await listProjects());
  });

  route("POST", "/api/projects", async ({ res, body }) => {
    const payload = asObject(body);
    const title = typeof payload.title === "string" ? payload.title : undefined;
    const project = await addProject(requireString(payload, "path"), title);
    bus.publish({ type: "projects_changed" });
    json(res, 201, project);
  });

  route("PUT", "/api/projects/order", async ({ res, body }) => {
    const { ids } = asObject(body);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw badRequest("ids must be an array of project ids");
    }
    const projects = await reorderProjects(ids as string[]);
    bus.publish({ type: "projects_changed" });
    json(res, 200, projects);
  });

  route("PATCH", "/api/projects/:id", async ({ res, params, body }) => {
    const { title } = asObject(body);
    if (typeof title !== "string") throw badRequest("title is required");
    const project = await renameProject(params.id!, title);
    bus.publish({ type: "projects_changed" });
    json(res, 200, project);
  });

  route("DELETE", "/api/projects/:id", async ({ res, params }) => {
    await removeProject(params.id!);
    bus.publish({ type: "projects_changed" });
    json(res, 200, { ok: true });
  });

  route("GET", "/api/projects/:id/sessions", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    // One page plus the total: the sidebar draws a few rows and labels "show
    // more" with the count, so it never has to hold every session of a
    // workspace (see `listSessions`).
    const page = await listSessions(project.path, {
      includeHidden: query.get("includeHidden") === "true",
      limit: optionalPositiveInt(query.get("limit")),
      focus: query.get("focus") ?? undefined,
    });
    json(res, 200, page);
  });

  /**
   * Slash commands available in a project: built-in commands, extension
   * commands, prompt templates, and skill commands.
   *
   * Built-in ones come from this server, not from pi — see `commands.ts`. They
   * are listed first and survive a failure to reach pi, since they need no
   * running process to be worth offering.
   */
  route("GET", "/api/projects/:id/commands", async ({ res, params }) => {
    const project = await getProject(params.id!);
    const builtin: SlashCommand[] = BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.argumentHint
        ? `${command.description}　${command.argumentHint}`
        : command.description,
      source: "builtin",
    }));

    try {
      json(res, 200, { commands: [...builtin, ...(await registry.listCommands(project.path))] });
    } catch (err) {
      // A failure here only costs the user their completions, so report it
      // inline instead of as an error banner.
      json(res, 200, { commands: builtin, error: (err as Error).message });
    }
  });

  /**
   * One directory level of a project's files, for the right sidebar's tree.
   *
   * Paths are relative to the project root and validated against it; the
   * sidebar addresses files this way rather than by absolute path so the route
   * cannot be turned into a general-purpose file reader.
   */
  route("GET", "/api/projects/:id/files", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    json(res, 200, await listWorkspaceDirectory(project.path, query.get("path") ?? ""));
  });

  /**
   * One file for the right sidebar's preview tab: text, an image as base64, or
   * a PDF by reference.
   *
   * A file the UI cannot render comes back as `kind: "unsupported"` with a
   * reason rather than as an HTTP error — "this is a .xlsx" is an answer, not a
   * failure, and the tab renders it differently from a broken read. A PDF is the
   * third case: it is renderable, just not here, so this answers with its size
   * and `/raw` hands over the bytes.
   */
  route("GET", "/api/projects/:id/file", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    json(res, 200, await readWorkspaceFile(project.path, path));
  });

  /**
   * One page of a text file, for files too large to hand over whole.
   *
   * The first page is what decides whether the reader pages at all: it carries
   * `eof`, so a file that fits in one page costs exactly one request more than
   * reading it whole would have. `offset` is a byte offset from the previous
   * page, not a line number — a line number would mean rescanning the file from
   * the start for every page.
   */
  route("GET", "/api/projects/:id/text", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const offset = Number(query.get("offset") ?? "0");
    json(res, 200, await readWorkspaceTextPage(project.path, path, offset));
  });

  /**
   * A file for the browser's own viewer rather than for this app's renderers.
   *
   * The PDF preview is the whole reason this route exists: the panel has no PDF
   * renderer, and the browser has one that keys off the response's content type.
   * Only `readWorkspaceRaw`'s list of formats is served — this is not a general
   * byte endpoint, and everything else still goes through `/file` as JSON.
   */
  route("GET", "/api/projects/:id/raw", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const file = await readWorkspaceRaw(project.path, path);
    res.writeHead(200, {
      "content-type": file.mimeType,
      "content-length": file.size,
      // `inline`, because this response is an iframe's source: a browser that
      // cannot display it should say so in place rather than download it.
      // The RFC 5987 form keeps a non-ASCII name intact and escapes CR/LF.
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      // A preview is reloaded on demand, so a cached copy would only ever be the
      // stale one.
      "cache-control": "no-store",
      // The type above is a promise about the bytes, and the promise is what
      // decides who renders them: a PDF is handed to the browser's own trusted
      // viewer without a sandbox, so a body that was not really a PDF must not
      // be allowed to talk the browser into rendering it as anything else.
      "x-content-type-options": "nosniff",
    });
    await pipeline(createReadStream(file.absolutePath), res);
  });

  /**
   * The changes panel's state: branch, staged/unstaged files with their patches,
   * upstream drift and recent history.
   *
   * "Not a git repository" is a normal answer (`repository: false` on a 200):
   * most directories this app can open are not repositories, and a 4xx would
   * make the panel render a failure where it should simply say so.
   */
  route("GET", "/api/projects/:id/git", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await readGitStatus(project.path));
  });

  /**
   * Stage or unstage paths — one file, or everything (`all: true`).
   *
   * Every write below answers with the re-read state rather than the bare
   * acknowledgement, so the panel never shows a list computed from what it
   * *expected* git to do.
   */
  route("POST", "/api/projects/:id/git/stage", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    if (typeof payload.staged !== "boolean") throw badRequest("staged must be a boolean");
    const view =
      payload.all === true
        ? await gitStageAll(project.path, payload.staged)
        : await gitStage(project.path, payload.paths, payload.staged);
    json(res, 200, view);
  });

  /** Commit what is staged. `-a` is deliberately not offered — see `git.ts`. */
  route("POST", "/api/projects/:id/git/commit", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    const result = await gitCommit(project.path, payload.message);
    bus.publish({ type: "projects_changed" });
    json(res, 200, result);
  });

  /**
   * Push the current branch.
   *
   * Slow by nature (network), and the only git write here that leaves the
   * machine. Force pushing is never offered.
   */
  route("POST", "/api/projects/:id/git/push", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await gitPush(project.path));
  });

  /** Throw away the work-tree changes of the given paths (the panel confirms first). */
  route("POST", "/api/projects/:id/git/discard", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    json(res, 200, await gitDiscard(project.path, payload.paths));
  });

  /** Switch to an existing local branch, then answer with the new state. */
  route("POST", "/api/projects/:id/git/branch", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    json(res, 200, await gitCheckout(project.path, payload.branch));
  });

  /**
   * The model a not-yet-created session in this project would start on, plus
   * every model it could switch to — what the new-session page's picker shows.
   *
   * Resolved from pi's own config files rather than from a prewarm process: the
   * list is ready in ~15ms with no spawn and no network (see
   * `readComposerFromDefaults`), so offering the choice before a session exists
   * costs nothing like opening one does.
   */
  route("GET", "/api/projects/:id/composer", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await readComposerFromDefaults());
  });

  // --- sessions -------------------------------------------------------------

  route("POST", "/api/sessions", async ({ res, body }) => {
    const payload = asObject(body);
    const { projectId } = payload;
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);
    const model = optionalModel(payload);

    // A prewarmed process has already paid pi's cold start, so it can be
    // handed over without waiting. Claiming it also frees the slot, so warm
    // the next one immediately to keep back-to-back "new session" instant.
    /**
     * 返回的 `sessionPath` 在会话落盘之前是 `draft:<项目路径>`。
     *
     * 为什么不是 jsonl 路径：实测 `system:init` 要到**第一条消息之后**才发，
     * 而会话 id（也就决定了文件名）只在 init 里出现。所以「刚新建、还没说话」的
     * 那一小段时间里，真实路径根本不存在。给一个 draft 键，前端照常把消息发给它，
     * `openSession` 会把它解析成项目并沿用同一个进程；等 init 到达、文件落盘后，
     * registry 把句柄迁到真路径上。
     */
    const claimed = registry.claimPrewarmed(project.path);
    if (claimed) {
      void registry.prewarm(project.path);
      json(res, 201, {
        sessionPath: makeDraftPath(project.path),
        sessionId: "",
        projectPath: project.path,
        prewarmed: true,
        ...(await applyModel(claimed, model)),
      });
      return;
    }

    const handle = await registry.open(project.path);
    json(res, 201, {
      sessionPath: makeDraftPath(handle.projectPath),
      sessionId: "",
      projectPath: handle.projectPath,
      prewarmed: false,
      ...(await applyModel(handle, model)),
    });
  });

  /**
   * Start warming a session for a project. Returns immediately: the caller
   * must not wait for pi's cold start.
   */
  route("POST", "/api/sessions/prewarm", async ({ res, body }) => {
    const { projectId } = asObject(body);
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);
    void registry.prewarm(project.path);
    json(res, 202, { ok: true, projectPath: project.path });
  });

  /**
   * The transcript, served from disk when no process is running.
   *
   * Switching to a session is the single most latency-sensitive action in the
   * UI, and it used to spawn pi (1.5–3.2s) just to read a file. A resident
   * session still answers from memory — it is authoritative there, and may hold
   * turns that have not been flushed yet — but everything else is read directly.
   */
  route("GET", "/api/sessions/:id/messages", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    if (live && !live.dead) {
      const messages = await callClient(live, () => live.client.getMessages());
      // pi answers this from the live session, so it already knows which user
      // messages are forkable — no need to re-derive it from the file.
      const forkPoints = await callClient(live, () => live.client.getForkMessages());
      json(res, 200, {
        sessionPath: live.sessionPath,
        sessionId: live.sessionId,
        messages,
        forkPoints,
      });
      return;
    }

    let snapshot;
    try {
      snapshot = await readSessionSnapshot(sessionPath);
    } catch (err) {
      throw notFound(`无法读取会话：${(err as Error).message}`);
    }
    json(res, 200, {
      sessionPath,
      sessionId: snapshot.sessionId,
      messages: snapshot.messages,
      forkPoints: snapshot.forkPoints,
    });
  });

  /**
   * Fork the session at a previous user message.
   *
   * This is not a copy — pi moves the session's leaf pointer back to that entry,
   * so the next prompt continues from there and the abandoned turns stay in the
   * file as a sibling branch. The response therefore reports the session's
   * identity *after* the fork; the caller has to reload the transcript, because
   * what the session now contains has changed.
   */
  route("POST", "/api/sessions/:id/fork", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const entryId = requireString(payload, "entryId");
    const handle = await openSession(sessionPath);
    const result = await callClient(handle, () => handle.client.fork(entryId));
    // Claude Code 的 fork 是「开一个新会话文件」，原会话一行不动 —— 这与 pi 的
    // 「把当前会话的 leaf 挪回去」相反。所以新路径必须从 fork 的结果里取；
    // 再去问原 `handle` 的 state 只会拿到原会话的文件。
    const forkedPath = result.text;
    json(res, 200, {
      ok: true,
      text: result.text,
      cancelled: result.cancelled,
      sessionPath: forkedPath,
      sessionId: handle.sessionId,
      sessionFile: forkedPath === "" ? null : forkedPath,
    });
  });

  route("GET", "/api/sessions/:id/state", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = await openSession(sessionPath);
    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { sessionPath: handle.sessionPath, state });
  });

  /**
   * The figures the composer shows on the right: the current model, the models
   * it could switch to, and the context-window usage.
   *
   * Served from the JSONL file whenever no process is resident, for the same
   * reason the transcript is: opening a session must not cost a pi cold start,
   * and pi records the model in the file itself (`model_change`). `spawn=true`
   * is the deliberate exception, used the moment the user opens the model menu
   * or the context panel — the *list* of switchable models only exists inside a
   * running process, and at that point the cold start is buying something the
   * user asked for rather than blocking a click on the sidebar.
   */
  route("GET", "/api/sessions/:id/composer", async ({ res, params, query }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    if (live && !live.dead) {
      json(res, 200, await liveComposer(live));
      return;
    }

    if (query.get("spawn") === "true") {
      const handle = await openSession(sessionPath);
      json(res, 200, await liveComposer(handle));
      return;
    }

    json(res, 200, await diskComposer(sessionPath));
  });

  /**
   * Switch the model a session talks to.
   *
   * pi persists this by appending a `model_change` entry, so the choice
   * survives a reload and is visible to the terminal as well. An unknown model
   * is the caller's mistake (`pi` rejects it too), so it answers 400 without
   * retiring the process — a healthy pi should not be killed over a bad id.
   */
  route("POST", "/api/sessions/:id/model", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const provider = requireString(payload, "provider");
    const id = requireString(payload, "id");
    const handle = await openSession(sessionPath);

    try {
      await handle.client.setModel(provider, id);
      registry.touch(handle.sessionPath);
    } catch (err) {
      throw badRequest(`无法切换到 ${provider}/${id}：${(err as Error).message}`);
    }

    json(res, 200, await liveComposer(handle));
  });

  route("POST", "/api/sessions/:id/prompt", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.prompt(message, images));
    json(res, 200, { ok: true, sessionPath: handle.sessionPath });
  });

  route("POST", "/api/sessions/:id/steer", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.steer(message, images));
    json(res, 200, { ok: true });
  });

  route("POST", "/api/sessions/:id/follow-up", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.followUp(message, images));
    json(res, 200, { ok: true });
  });

  route("POST", "/api/sessions/:id/abort", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.abort());
    json(res, 200, { ok: true });
  });

  // --- 本项目新增：权限、用量、CLI 元信息、上游健康 ---------------------------

  /**
   * 切换权限模式。
   *
   * 六态来自 Claude Code 自己：`default` / `acceptEdits` / `plan` / `dontAsk` /
   * `auto` / `bypassPermissions`。会话级状态，新会话永远从 `default` 开始。
   *
   * `bypassPermissions` 的二次确认在**前端**做（切换要确认 + 常驻警告条）；
   * 服务端只负责把它如实转发给 CLI，不替用户做决定，也绝不自己加上
   * `--dangerously-skip-permissions`。
   */
  route("POST", "/api/sessions/:id/permission-mode", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const mode = requireString(payload, "mode");
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
      throw badRequest(
        `permissionMode 必须是 ${PERMISSION_MODES.join(" / ")} 之一（收到 ${mode}）`,
      );
    }
    const handle = await openSession(sessionPath);
    registry.setPermissionMode(handle.sessionPath, mode as PermissionMode);
    json(res, 200, { ok: true, permissionMode: mode });
  });

  /** 当前会话挂着的权限请求。刷新页面后靠它恢复卡片。 */
  route("GET", "/api/sessions/:id/permissions", ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    json(res, 200, { pending: registry.pendingPermissions(sessionPath) });
  });

  /**
   * 回答一张权限卡。
   *
   * 三个按钮的语义由 `agent/controls.ts` 决定：
   *   `user_temporary` → 允许一次
   *   `user_permanent` → 总是允许（写 `~/.claude/settings.json`，与终端的 /permissions 一致）
   *   `user_reject`    → 拒绝
   *
   * `updatedInput` 允许前端改写工具入参，但不会裁剪 —— 见 SECURITY.md 硬边界 3。
   */
  route("POST", "/api/sessions/:id/permissions/:requestId", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const classification = requireString(payload, "classification");
    if (
      classification !== "user_temporary" &&
      classification !== "user_permanent" &&
      classification !== "user_reject"
    ) {
      throw badRequest("classification 必须是 user_temporary / user_permanent / user_reject");
    }
    const behavior = classification === "user_reject" ? "deny" : "allow";
    const answered = registry.answerPermission(sessionPath, params.requestId!, {
      behavior,
      classification,
      message: optionalString(payload, "message"),
      interrupt: payload.interrupt === true,
      updatedInput: isRecord(payload.updatedInput) ? payload.updatedInput : undefined,
    });
    if (!answered) throw notFound("这张权限卡已经不存在或已过期");
    json(res, 200, { ok: true });
  });

  /**
   * 用量与开销。
   *
   * 数字来自 Claude Code 的 `result` 事件（`total_cost_usd` / `num_turns` /
   * `duration_ms` / `usage`），不自己估。上游不返回时显示未知，不猜。
   */
  route("GET", "/api/sessions/:id/usage", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = registry.get(sessionPath);
    const snapshot = await readSessionSnapshot(sessionPath).catch(() => null);

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let turns = 0;
    for (const message of snapshot?.messages ?? []) {
      const role = (message as { role?: string }).role;
      if (role !== "assistant") continue;
      turns += 1;
      const usage = (message as { usage?: Record<string, number> }).usage;
      if (usage === undefined) continue;
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cacheRead += usage.cacheRead ?? 0;
      cacheWrite += usage.cacheWrite ?? 0;
    }

    json(res, 200, {
      live: handle !== undefined && !handle.dead,
      model: handle?.initModel ?? null,
      contextTokens: handle?.lastUsage ?? null,
      turns,
      usage: { input, output, cacheRead, cacheWrite },
      // 花费是 CLI 在 result 事件里报的，我们只在拿到过的时候给数字。
      totalCostUsd: null,
    });
  });

  /**
   * CLI 元信息：找到的是哪个可执行文件、什么版本、从哪条规则找到的。
   *
   * 首屏与设置页都用它。找不到时返回 200 + `ok: false` 加可操作的提示，
   * 而不是 500 —— 用户需要看到那条提示，不是错误页。
   */
  route("GET", "/api/meta/cli", async ({ res }) => {
    const located = await locateClaudeCli();
    if (!located.ok) {
      json(res, 200, { ok: false, message: located.message, attempts: located.attempts });
      return;
    }
    json(res, 200, {
      ok: true,
      path: located.cli.path,
      version: located.cli.version,
      semver: located.cli.semver,
      source: located.cli.source,
    });
  });

  /**
   * 上游健康检查。
   *
   * 用户环境里常见：key 过期、`ANTHROPIC_BASE_URL` 填错、代理挂了。实测本机就
   * 把 base_url 指到了一个不兼容的代理，每个请求都 400。让用户在聊天框里看到
   * 一个裸 400 是不可接受的，所以首屏先问这里。
   *
   * **不做真实模型调用**：那会花钱、会花时间，而且可能被上游限流。这里只报
   * 「配置看起来是什么样」+「CLI 在不在」。
   */
  route("GET", "/api/health/upstream", async ({ res }) => {
    const located = await locateClaudeCli();
    const summary = await configSummary();
    const settings = await readSettings();

    const problems: string[] = [];
    if (!located.ok) {
      problems.push(located.message);
    }
    if (summary.hasBaseUrlOverride) {
      problems.push(
        "settings.json 里覆盖了 ANTHROPIC_BASE_URL。如果上游报错，先检查这一项 —— 注意它的优先级高于 shell 环境变量。",
      );
    }
    if (!summary.hasBaseUrlOverride && summary.envKeys.length === 0) {
      problems.push(
        "settings.json 的 env 里没有上游配置。若你依赖 shell 环境变量，请确认 claude 能读到它们。",
      );
    }

    json(res, 200, {
      cli: located.ok
        ? { found: true, version: located.cli.version, path: located.cli.path }
        : { found: false, message: located.message },
      settingsPath: summary.path,
      model: summary.model ?? settings.model ?? null,
      permissionDefaultMode: summary.permissionDefaultMode,
      // 只报键名，绝不返回值。
      envKeys: summary.envKeys,
      hasBaseUrlOverride: summary.hasBaseUrlOverride,
      problems,
    });
  });

  /**
   * 模型候选。
   *
   * 全部动态读：`settings.json` 的 `modelPicker.options` ∪ 当前生效模型 ∪ 默认模型。
   * 任何地方都不硬编码模型名。
   */
  route("GET", "/api/meta/models", async ({ res, query }) => {
    const current = query.get("current");
    json(res, 200, { models: await listModels(current) });
  });

  /**
   * Run a built-in slash command (`/compact`, `/export`, …).
   *
   * These are not prompts — each maps to a dedicated RPC method — so the text
   * never reaches the model. The reply is a single line for the user.
   */
  route("POST", "/api/sessions/:id/command", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const name = requireString(payload, "name");
    const args = typeof payload.args === "string" ? payload.args : "";
    const handle = await openSession(sessionPath);
    const message = await callClient(handle, () => runBuiltinCommand(handle, name, args));
    json(res, 200, { ok: true, message });
  });

  /**
   * Rename a session by writing pi's own `session_info` entry, so the Web UI
   * and the CLI cannot disagree about what a session is called. An empty name
   * clears it, which is how "back to automatic" is spelled without a second
   * endpoint. See `session-title.ts` for the two writers.
   */
  route("POST", "/api/sessions/:id/rename", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { name } = asObject(body);
    if (typeof name !== "string") throw badRequest("name is required");
    if (!existsSync(sessionPath)) throw notFound("会话文件不存在");
    const trimmed = name.trim();
    // Claude Code 的 jsonl 里没有「会话名」这个概念，所以手动标题存在本项目
    // 自己的 store 里（`~/.anhe-claude-web`），绝不写 `~/.claude`。
    await setSessionOverride(sessionPath, { name: trimmed });
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, name: trimmed });
  });

  route("POST", "/api/sessions/:id/hidden", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { hidden } = asObject(body);
    if (typeof hidden !== "boolean") throw badRequest("hidden must be a boolean");
    const override = await setSessionOverride(sessionPath, { hidden });
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, override });
  });

  /**
   * Delete a session for good.
   *
   * The resident pi process is retired first, so nothing keeps a file handle
   * on a JSONL that is about to disappear — and so the next click on that row
   * cannot respawn against a missing file. The file itself prefers the system
   * trash (see `session-delete.ts`), and the UI-side rename/hide override goes
   * with it. Sessions live only in pi's storage, so there is no local copy to
   * clean up beyond that override.
   */
  route("DELETE", "/api/sessions/:id", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "deleted");
    // The session is gone for good, so its shells have nowhere left to be
    // shown. Leaving them running would keep a `node` process alive under a
    // tab that can never be reopened.
    terminals.closeForSession(sessionPath);
    const result = await deleteSession(sessionPath);
    if (!result.ok) {
      if (result.missing === true) throw notFound("会话文件不存在");
      throw new HttpError(500, `无法删除会话：${result.error}`);
    }
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, method: result.method });
  });

  route("POST", "/api/sessions/:id/stop", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "user-request");
    json(res, 200, { ok: true });
  });

  /**
   * Re-read a session from disk. Used after `session_external_changed`: the
   * Web UI drops its process and adopts whatever the CLI wrote last.
   */
  route("POST", "/api/sessions/:id/reload", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "reload");
    const handle = await openSession(sessionPath);
    const messages = await callClient(handle, () => handle.client.getMessages());
    json(res, 200, {
      ok: true,
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      messages,
    });
  });

  // --- terminals ------------------------------------------------------------

  /**
   * Where a session's shell starts.
   *
   * A live session answers directly: its handle carries the canonical project
   * directory the pi process runs in. One that has not been opened yet is read
   * from disk — the same lookup `openSession` does, minus the spawn, because
   * opening a shell must not cost a pi process.
   *
   * A draft session has neither. pi writes a session file only once an
   * assistant message arrives, so until then there is nothing on disk to read,
   * and the client sends the workspace it is showing instead. That path is
   * checked against the registered projects rather than trusted: it still
   * arrives from a browser, and while "browse the host filesystem" is a feature
   * this app has on purpose (the directory picker), "run a shell anywhere" is
   * not one of them.
   */
  const terminalCwd = async (input: {
    sessionPath: string;
    requested: string | undefined;
  }): Promise<string> => {
    if (input.sessionPath.length > 0) {
      const live = registry.get(input.sessionPath);
      if (live !== undefined) return live.projectPath;
      // The id has to be checked before it is handed to `SessionManager`. On a
      // path that is not a session — a draft, `draft:…`, is one — `open` does
      // not fail: it answers with the *server process's own* working directory.
      // Trusting that would start a brand-new session's shell wherever the
      // server happened to be launched, and would skip the workspace check
      // below for exactly the case that check exists for.
      if (isSessionFile(input.sessionPath)) {
        try {
          return await sessionCwd(input.sessionPath);
        } catch {
          // On disk but unreadable. The requested workspace below answers.
        }
      }
    }
    if (input.requested !== undefined) {
      const projects = await listProjects();
      const known = projects.find((project) => project.path === input.requested);
      if (known !== undefined) return known.path;
      throw badRequest(`不是已注册的工作区：${input.requested}`);
    }
    throw badRequest("无法确定这个会话的工作目录");
  };

  /**
   * What this host can offer, and what is already open for a session.
   *
   * One request rather than two because the panel asks both questions at the
   * same moment — the instant a terminal tab mounts — and the second is
   * meaningless when the answer to the first is "no shells here". The support
   * half is cheap: it reports whether the optional module loads, not whether a
   * shell can start.
   */
  route("GET", "/api/terminal", ({ res, query }) => {
    const requested = query.get("sessionPath");
    const sessionPath = requested === null || requested.length === 0 ? undefined : requested;
    json(res, 200, {
      support: terminals.support(),
      terminals: terminals.list(sessionPath),
    });
  });

  /** Open a shell. The response is the tab's handle, so it is a 201. */
  route("POST", "/api/terminal", async ({ res, body }) => {
    const payload = asObject(body);
    const sessionPath = optionalString(payload, "sessionPath") ?? "";
    const cols = requireNumber(payload, "cols");
    const rows = requireNumber(payload, "rows");
    const cwd = await terminalCwd({
      sessionPath,
      requested: optionalString(payload, "cwd"),
    });
    json(
      res,
      201,
      terminals.create({ sessionPath, cwd, cols, rows }),
    );
  });

  /**
   * The screen so far.
   *
   * Fetched by a tab that is mounting onto a shell that has been running
   * without it — a sidebar toggle, a page reload, a session switch — so what it
   * draws first is everything that happened, not everything from now on.
   */
  route("GET", "/api/terminal/:id", ({ res, params }) => {
    const scrollback = terminals.scrollbackOf(params.id!);
    if (scrollback === null) throw notFound(`终端不存在：${params.id!}`);
    json(res, 200, { scrollback });
  });

  route("POST", "/api/terminal/:id/input", ({ res, params, body }) => {
    terminals.write(params.id!, requireString(asObject(body), "data"));
    json(res, 200, { ok: true });
  });

  route("POST", "/api/terminal/:id/resize", ({ res, params, body }) => {
    const payload = asObject(body);
    terminals.resize(
      params.id!,
      requireNumber(payload, "cols"),
      requireNumber(payload, "rows"),
    );
    json(res, 200, { ok: true });
  });

  /**
   * Close a shell.
   *
   * An id that is already gone answers `{ closed: false }` rather than 404:
   * closing a tab and closing the session it belongs to race by nature, and the
   * loser of that race was not doing anything wrong.
   */
  route("DELETE", "/api/terminal/:id", ({ res, params }) => {
    json(res, 200, { closed: terminals.close(params.id!) });
  });

  // --- extension UI responses ----------------------------------------------

  /**
   * The dialogs still waiting on the user.
   *
   * A page that loads (or reloads) while a dialog is pending learns about it
   * here: the SSE stream carries no history, so without this the card would
   * never come back and the pi process would stay blocked with nobody able to
   * answer it.
   */
  route("GET", "/api/ui-requests", ({ res }) => {
    json(res, 200, { requests: uiRequests.list() });
  });

  /**
   * Answer a dialog by its own id.
   *
   * The id is the address rather than the session path, because a fresh session
   * has no path yet when its extension asks: pi only reports one through
   * `get_state`, after `session_start` has already run.
   */
  route("POST", "/api/ui-requests/:id/response", async ({ res, params, body }) => {
    const payload = asObject(body);
    const answered = await uiRequests.answer(params.id!, payload);
    if (!answered) throw notFound("no dialog is waiting under that id");
    json(res, 200, { ok: true });
  });

  // --- event stream ---------------------------------------------------------

  /**
   * Live SSE connections, keyed by the id handed to the client in `hello`.
   *
   * Two things live here that the client cannot know on its own: which session
   * this tab is reading, and how far behind its socket has fallen.
   */
  interface EventStream {
    /**
     * The session this client is reading.
     *
     * `undefined` (not declared yet) means send everything: the frames before
     * the client's first subscription must not be lost, and a client that never
     * subscribes is an older build. `null` means it is reading no session and
     * wants none of the per-session stream.
     */
    sessionPath: string | null | undefined;
    /** Set while `res.write` reported a full buffer; cleared by `drain`. */
    throttled: boolean;
    /** Frames held back while throttled, in order. */
    queue: string[];
    /** Running byte total of `queue` — the bound that actually matters. */
    queuedBytes: number;
  }

  const streams = new Map<string, EventStream>();

  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const stream: EventStream = {
      sessionPath: undefined,
      throttled: false,
      queue: [],
      queuedBytes: 0,
    };
    const connectionId = randomUUID();
    streams.set(connectionId, stream);

    /**
     * Write a frame, waiting out the socket's own buffer when it is full.
     *
     * `res.write` returning false is Node saying its buffer is full — the
     * client is not reading fast enough. Ignoring that (writing anyway) is what
     * let a stalled stream grow without bound: the benchmark held ~690MB across
     * four slow readers. Here the frame waits for `drain`, every later frame
     * queues behind it, and a queue past the cap ends the connection.
     *
     * Ending it is the only honest option. The held frames are stream deltas,
     * so discarding them would leave the transcript wrong; a dropped socket
     * makes `EventSource` reconnect, and the client re-reads an authoritative
     * snapshot on the way back.
     */
    const write = (chunk: string): void => {
      if (res.destroyed) return;
      if (stream.throttled) {
        stream.queue.push(chunk);
        stream.queuedBytes += Buffer.byteLength(chunk);
        if (stream.queuedBytes > sseMaxBufferedBytes) {
          stream.queue.length = 0;
          stream.queuedBytes = 0;
          res.destroy();
        }
        return;
      }
      if (!res.write(chunk)) stream.throttled = true;
    };

    res.on("drain", () => {
      stream.throttled = false;
      while (stream.queue.length > 0) {
        const next = stream.queue.shift()!;
        stream.queuedBytes -= Buffer.byteLength(next);
        if (!res.write(next)) {
          stream.throttled = true;
          return;
        }
      }
    });

    // Ask the browser to come back within a second: a reconnect only costs a
    // snapshot read, and waiting out its multi-second default stalls the UI.
    write("retry: 1000\n\n");
    write(": connected\n\n");
    write(
      `event: hello\ndata: ${JSON.stringify({
        connectionId,
        activeSessions: registry.list().map((handle) => handle.sessionPath),
      })}\n\n`,
    );

    const unsubscribe = bus.subscribe((event) => {
      if (!wantsFrame(stream.sessionPath, event)) return;
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(": ping\n\n"), 20_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(connectionId);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  /**
   * Point a live stream at the session its tab is reading.
   *
   * The client calls this on every session switch. Until it lands the stream
   * still carries everything, so a switch never races the filter.
   */
  route("POST", "/api/events/subscription", ({ res, body }) => {
    const payload = asObject(body);
    const stream = streams.get(requireString(payload, "connectionId"));
    if (!stream) throw notFound("no live event stream with that id");
    stream.sessionPath =
      payload.sessionPath === null ? null : requireString(payload, "sessionPath");
    json(res, 200, { ok: true });
  });

  // --- dispatch -------------------------------------------------------------

  const matchRoute = (
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null => {
    const segments = pathname.split("/").filter(Boolean);
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      if (candidate.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < candidate.segments.length; i += 1) {
        const pattern = candidate.segments[i]!;
        const value = segments[i]!;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: candidate.handler, params };
    }
    return null;
  };

  return async (req, res) => {
    try {
      assertLocalRequest(req);

      const url = new URL(req.url ?? "/", "http://localhost");
      const match = matchRoute(req.method ?? "GET", url.pathname);
      if (!match) {
        // Not an API route: the built front end gets first refusal, and only
        // then does an unknown path become a 404.
        if (staticHandler && (await staticHandler(req, res, url.pathname))) {
          return;
        }
        json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
        return;
      }
      const body = BODY_METHODS.has(req.method ?? "GET") ? await readJsonBody(req) : undefined;
      await match.handler({ req, res, params: match.params, query: url.searchParams, body });
    } catch (err) {
      const httpError = toHttpError(err);
      if (!res.headersSent) {
        json(res, httpError.status, { error: httpError.message });
      } else {
        res.end();
      }
    }
  };
}
