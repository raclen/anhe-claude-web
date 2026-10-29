import type { UpdatesView, VersionInfo } from "./types.ts";
import type { Translate } from "./i18n/index.ts";

/**
 * Pure projections of the update payload.
 *
 * There is exactly one surface that answers "is this app behind?": the sidebar
 * badge, the 关于 row and the plugins header all read the same `self` answer.
 * Nothing here touches React or the store, which is what lets the wording be
 * tested on its own.
 */

/**
 * True when the app itself is behind its published version. This is the sidebar
 * badge's question — the badge is about the tool, not about any workspace.
 */
export function hasAnyUpdate(view: UpdatesView | null): boolean {
  if (view === null) return false;
  return view.self.available;
}

/**
 * The version row's status.
 *
 * The order matters: a skipped or failed check must not fall through to "已是最新",
 * because that string is a claim about the world and these states do not know
 * it. `null` means the answer has not arrived yet.
 */
export function versionStatus(info: VersionInfo | null, t: Translate): string {
  if (info === null) return t("updates.checking");
  if (info.skipped) return t("updates.skipped");
  if (info.error !== null) return t("updates.failed");
  if (info.available) {
    return info.latest === null
      ? t("updates.available")
      : t("updates.availableVersion", { version: info.latest });
  }
  return t("updates.upToDate");
}
