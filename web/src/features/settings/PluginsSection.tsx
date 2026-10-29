import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { ExtensionItem } from "../../lib/types.ts";
import { extensionKindLabel, extensionStateLabel, groupExtensions, groupMeta } from "./plugin-model.ts";
import styles from "./PluginsSection.module.css";

/**
 * The plugins section: what Claude Code would load, read from its own folders.
 *
 * **Read-only on purpose.** Enablement lives in Claude Code's private config
 * (`~/.claude/settings.json`, `/plugin`, `/config`); writing it back from a UI
 * would be a double-write onto a format with no public contract, which is the
 * same reason MCP is read-only here. The rows therefore *report* state rather
 * than offering a switch that cannot be honoured.
 *
 * There is no per-entry "update" either: this app installs no extensions of its
 * own — skills, plugins and agents are Claude Code's to manage in the terminal.
 */

type Scope = "user" | "project";

export function PluginsSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<Scope, boolean>>({
    user: false,
    project: false,
  });
  const [expanded, setExpanded] = useState<Record<string, true>>({});

  const projectPath =
    state.projects.find((project) => project.id === state.selectedProjectId)?.path ?? null;

  const view = state.extensions;

  useEffect(() => {
    // The inventory depends on the workspace, so switching workspaces has to
    // re-resolve rather than keep showing the previous one's entries.
    void actions.loadExtensions(projectPath);
  }, [projectPath]);

  const groups = useMemo(() => groupExtensions(view, query), [view, query]);
  const searching = query.trim().length > 0;
  const total = view?.items.length ?? 0;
  const matched = groups.user.length + groups.project.length;

  const toggle = (scope: Scope): void => {
    setCollapsed((previous) => ({ ...previous, [scope]: !previous[scope] }));
  };

  return (
    <div className={className}>
      <div className={styles.header}>
        <h1 className={styles.heading}>{t("settings.nav.plugins")}</h1>
      </div>

      <p className={styles.lead}>{t("settings.plugins.lead")}</p>
      <p className={styles.note}>{t("settings.plugins.readOnly")}</p>

      <div className={styles.search}>
        <Glyph name="search" size={16} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          type="search"
          value={query}
          placeholder={t("settings.plugins.searchPlaceholder")}
          aria-label={t("settings.plugins.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {view === null ? (
        <div className={styles.placeholder}>{t("settings.plugins.loading")}</div>
      ) : view.errors.length > 0 && total === 0 ? (
        <div className={styles.failure}>
          <p className={styles.failureText}>{t("settings.plugins.failed")}</p>
          {view.errors.map((error) => (
            <p key={error.path} className={styles.failureDetail}>
              {error.path} — {error.message}
            </p>
          ))}
          <button
            type="button"
            className={styles.retry}
            onClick={() => void actions.loadExtensions(projectPath)}
          >{t("common.retry")}</button>
        </div>
      ) : total === 0 ? (
        <div className={styles.placeholder}>{t("settings.plugins.empty")}</div>
      ) : searching && matched === 0 ? (
        <div className={styles.placeholder}>{t("settings.plugins.noMatch")}</div>
      ) : (
        <>
          {(["user", "project"] as const).map((scope) => {
            const items = groups[scope];
            // The workspace group only exists when it contributed something. An
            // empty heading would say "this workspace has none" about a
            // workspace that was never looked at.
            if (scope === "project" && items.length === 0) return null;
            if (searching && items.length === 0) return null;

            return (
              <section key={scope} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-expanded={!collapsed[scope]}
                  onClick={() => toggle(scope)}
                >
                  <Glyph
                    name="chevronDown"
                    size={14}
                    className={clsx(
                      styles.groupChevron,
                      collapsed[scope] && styles.groupChevronCollapsed,
                    )}
                  />
                  <span className={styles.groupTitle}>{groupMeta(t)[scope].title}</span>
                  <span className={styles.groupSub}>{groupMeta(t)[scope].subtitle}</span>
                  <span className={styles.groupCount}>{t("settings.plugins.groupCount", { count: items.length })}</span>
                </button>

                {!collapsed[scope] || searching ? (
                  <div className={styles.cards}>
                    {items.map((item) => (
                      <PluginCard
                        key={item.id}
                        item={item}
                        expanded={expanded[item.id] === true}
                        onToggle={() =>
                          setExpanded((previous) => {
                            const next = { ...previous };
                            if (next[item.id]) delete next[item.id];
                            else next[item.id] = true;
                            return next;
                          })
                        }
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </>
      )}

      {view !== null && view.errors.length > 0 && total > 0 ? (
        <p className={styles.note}>{t("settings.plugins.partialRead", { count: view.errors.length })}</p>
      ) : null}
    </div>
  );
}

function PluginCard({
  item,
  expanded,
  onToggle,
}: {
  item: ExtensionItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.card}>
      <div className={styles.cardMainRow}>
        <button
          type="button"
          className={styles.cardToggle}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Glyph
            name="chevronDown"
            size={14}
            className={clsx(styles.cardChevron, !expanded && styles.cardChevronCollapsed)}
          />
          <span className={styles.cardTitle}>{item.name}</span>
          <span className={styles.cardBadge}>{extensionKindLabel(item, t)}</span>
        </button>

        <span
          className={clsx(
            styles.status,
            item.enabled === true && styles.statusOn,
            item.enabled === false && styles.statusOff,
          )}
        >
          {extensionStateLabel(item, t)}
        </span>
      </div>

      {expanded ? (
        <dl className={styles.details}>
          <DetailRow label={t("settings.plugins.pathLabel")} value={item.path} />
          <DetailRow label={t("settings.plugins.kindLabel")} value={extensionKindLabel(item, t)} />
          {item.version !== null ? (
            <DetailRow label={t("settings.plugins.versionLabel")} value={item.version} />
          ) : null}
          {item.description !== null ? (
            <DetailRow label={t("settings.plugins.descriptionLabel")} value={item.description} />
          ) : null}
          <DetailRow label={t("settings.plugins.stateLabel")} value={extensionStateLabel(item, t)} />
        </dl>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailRow}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}
