/**
 * Claude Code 适配层的公开出口。
 *
 * 除了这个目录里的四个文件（`locate` / `normalize` / `controls` / `registry`），
 * 仓库里任何地方都不应该知道 Claude Code 的线上格式 —— 见 PROJECT_RULES.md 第三节。
 */
export {
  asCanUseToolRequest,
  cancelRequestCommand,
  decideAllowOnce,
  decideAlwaysAllow,
  decideDeny,
  errorResponse,
  fallbackRule,
  interruptCommand,
  isControlRequest,
  isPermissionMode,
  setMaxThinkingTokensCommand,
  setModelCommand,
  setPermissionModeCommand,
  successResponse,
  PERMISSION_MODES,
  type CanUseToolRequest,
  type CanUseToolResponse,
  type ControlRequestEnvelope,
  type ControlResponseEnvelope,
  type DecisionClassification,
  type PermissionBehavior,
  type PermissionDestination,
  type PermissionMode,
  type PermissionRule,
  type PermissionUpdate,
} from "./controls.ts";

export { invalidateClaudeCliCache, locateClaudeCli, parseVersion, type ClaudeCli, type LocateResult } from "./locate.ts";

export { Normalizer, type NormalizedEvent } from "./normalize.ts";

export {
  registry,
  SessionRegistry,
  SessionRegistryError,
  type PendingPermission,
  type PermissionAnswer,
  type SessionHandle,
} from "./registry.ts";

export {
  configSummary,
  effortLevelFor,
  listModels,
  readSettings,
  settingsPath,
  type ComposerModel,
} from "./models.ts";

export {
  getSessionRoot,
  invalidateSessionCache,
  listKnownProjects,
  listSessions,
  type ListSessionsOptions,
  type SessionListPage,
  type SessionView,
  type TitleSource,
} from "./sessions.ts";
