/**
 * Claude Code 适配层的转发出口。
 *
 * 实现在 `agent/registry.ts`。本文件存在于 pi-web 的既有 import 路径上
 * （`./registry.ts`），保留它是为了不动 `routes.ts` / `index.ts` 的 import。
 */
export {
  registry,
  SessionRegistry,
  SessionRegistryError,
  type PendingPermission,
  type PermissionAnswer,
  type SessionClient,
  type SessionEventListener,
  type SessionHandle,
  type SessionRegistryOptions,
  type SlashCommand,
} from "./agent/registry.ts";

export { PERMISSION_MODES, type PermissionMode } from "./agent/controls.ts";
