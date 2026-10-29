import type { ExtensionItem, ExtensionsView } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

/**
 * Pure model for the plugins section: which group an extension belongs to and
 * whether the current query keeps it. Kept out of the component so the search
 * contract (what a query is matched against) can be tested on its own — the
 * component only decides how to draw the result.
 */

export type PluginScope = "user" | "project";

/**
 * The two groups, both open by default.
 *
 * The global list is the one that always exists — a workspace may have no
 * `/`.claude` at all — so folding it would hide the page's main content for no
 * reason.
 */
export function groupMeta(
  t: Translate,
): Record<PluginScope, { title: string; subtitle: string }> {
  return {
    user: {
      title: t("settings.pluginScope.user.title"),
      subtitle: t("settings.pluginScope.user.subtitle"),
    },
    project: {
      title: t("settings.pluginScope.project.title"),
      subtitle: t("settings.pluginScope.project.subtitle"),
    },
  };
}

/** The row's kind, in the terms Claude Code uses (skill / plugin / sub-agent). */
export function extensionKindLabel(item: ExtensionItem, t: Translate): string {
  if (item.kind === "skill") return t("settings.pluginKind.skill");
  if (item.kind === "plugin") return t("settings.pluginKind.plugin");
  return t("settings.pluginKind.agent");
}

/**
 * Whether an entry is on. `null` is "could not tell", which must not be rounded
 * to "off" — the page would then claim something it does not know.
 */
export function extensionStateLabel(item: ExtensionItem, t: Translate): string {
  if (item.enabled === null) return t("settings.plugins.stateUnknown");
  return item.enabled ? t("common.enabled") : t("common.disabled");
}

/**
 * Split the inventory into its two scopes and apply the search.
 *
 * Matching covers the path and the description as well as the label, since
 * someone looking for an entry is as likely to type part of where it lives or
 * what it does. An empty query keeps everything, which is what makes the count
 * next to each group heading mean "how many live here" rather than "how many
 * matched" when nothing is being searched for.
 */
export function groupExtensions(
  view: ExtensionsView | null,
  query: string,
): Record<PluginScope, ExtensionItem[]> {
  const groups: Record<PluginScope, ExtensionItem[]> = { user: [], project: [] };
  if (view === null) return groups;

  const needle = query.trim().toLowerCase();
  for (const item of view.items) {
    if (needle.length > 0) {
      const haystack = `${item.name} ${item.path} ${item.description ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    groups[item.scope].push(item);
  }
  return groups;
}
