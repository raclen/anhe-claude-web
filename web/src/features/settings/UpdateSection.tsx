import { useEffect, useState } from "react";
import clsx from "clsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { versionStatus } from "../../lib/updates.ts";
import { SettingsGroup, SettingsRow } from "./SettingsRow.tsx";
import styles from "./UpdateSection.module.css";

/**
 * The version notice, at the bottom of 通用设置.
 *
 * One row, because there is one fact to report. **This app** is an npm package:
 * a newer release moves with `npm i -g` and takes a restart, so the row reports
 * the version and offers its command to copy rather than a button that would
 * have to half-do the job.
 *
 * The check is not run from the browser: the server owns it, and its short cache
 * means visiting the page does not spawn a check. The 检查更新 button is the
 * explicit "ask upstream again".
 */
export function UpdateSection() {
  const t = useT();
  const state = useStore(appStore);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  // One answer for the whole app, so the settings page and the sidebar badge
  // read the same slot and neither refetches on switch.
  const view = state.updates;
  const info = view?.self ?? null;

  useEffect(() => {
    if (view === null) void actions.loadUpdates();
  }, [view]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const check = (): void => {
    setChecking(true);
    void actions.loadUpdates({ force: true }).finally(() => setChecking(false));
  };

  const copyCommand = (): void => {
    const command = info?.updateCommand ?? "";
    if (command.length === 0) return;
    // The clipboard API rejects on a non-secure origin; the shell is served
    // over plain http on localhost, which browsers do treat as secure, but the
    // rejection is still handled so a failure is not a silent no-op.
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch(() => actions.setNotice(command));
  };

  return (
    <SettingsGroup title={t("settings.updates.about")}>
      <SettingsRow
        title={t("settings.updates.version")}
        description={t("settings.updates.versionDescription")}
      >
        <div className={styles.control}>
          <span className={styles.version}>{info?.current ?? "—"}</span>
          <span
            className={clsx(
              styles.status,
              info !== null && info.available && styles.statusNew,
              info !== null && info.error !== null && styles.statusError,
            )}
          >
            {versionStatus(info, t)}
          </span>
          {info !== null && info.available ? (
            <button
              type="button"
              className={styles.action}
              title={info.updateCommand}
              onClick={copyCommand}
            >
              {copied ? t("common.copied") : t("settings.updates.copyCommand")}
            </button>
          ) : null}
          <button type="button" className={styles.ghost} disabled={checking} onClick={check}>
            {checking ? t("settings.updates.checking") : t("settings.updates.check")}
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
