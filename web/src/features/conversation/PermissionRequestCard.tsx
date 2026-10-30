import { useState } from "react";
import { useT } from "../../lib/app-state.ts";
import type { PermissionRequest } from "./useConversation.ts";
import styles from "./PermissionCard.module.css";

/**
 * 那张「允许一次 / 总是允许 / 拒绝」的权限卡。
 *
 * **它和 `PermissionDeniedCard` 是两件事。** 那张是事后的拒绝说明，这张是
 * 正在发生的提问 —— CLI 那一轮此刻就停在这里，等主人按下其中一个按钮。
 *
 * 两条硬约束：
 * - **入参原样完整展示**，不截断、不美化（SECURITY.md 硬边界 3）。主人要看清
 *   `Bash` 到底跑什么、`Write` 到底往哪写。长命令宁可滚动也不裁。
 * - 三个按钮的差别是真实的：「总是允许」会写进 `~/.claude/settings.json` 的
 *   `permissions.allow`，与终端里 `/permissions` 的行为一致，所以文案要把这件事
 *   说出来，不能只写「允许」。
 */
export interface PermissionRequestCardProps {
  request: PermissionRequest;
  /** 会话不在当前视图时显示它的名字，并提供跳转。 */
  sessionLabel?: string;
  onOpenSession?: () => void;
  onAnswer(
    requestId: string,
    classification: "user_temporary" | "user_permanent" | "user_reject",
  ): Promise<void>;
}

/** 把工具入参渲染成给人看的样子。JSON 保持缩进；单个字符串则原样铺开。 */
function formatInput(input: Record<string, unknown>): string {
  // `Bash` / `Write` 这类工具只有一个关键字段，把值单独摊开比打印 `{"command":…}`
  // 好读得多，也少一层转义噪音。其余工具照旧打印完整 JSON。
  const keys = Object.keys(input);
  if (keys.length === 1) {
    const only = input[keys[0]!];
    if (typeof only === "string") return only;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function PermissionRequestCard({
  request,
  sessionLabel,
  onOpenSession,
  onAnswer,
}: PermissionRequestCardProps) {
  const t = useT();
  const [busy, setBusy] = useState<"allow-once" | "always" | "deny" | null>(null);

  const choose = (classification: "user_temporary" | "user_permanent" | "user_reject",
    which: "allow-once" | "always" | "deny"): void => {
    if (busy !== null) return;
    setBusy(which);
    // 失败不在这里恢复按钮：错误由 hook 记到会话的 error，并且服务端没回答时
    // 卡会留着 —— 留着是对的，主人可以再试一次。
    void onAnswer(request.requestId, classification);
  };

  return (
    <section className={styles.request} role="alertdialog" aria-label={t("permission.requestTitle")}>
      <header className={styles.requestHeader}>
        {sessionLabel ? (
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowText}>{sessionLabel}</span>
            {onOpenSession ? (
              <button type="button" className={styles.eyebrowAction} onClick={onOpenSession}>
                {t("question.goTo")}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={styles.requestTitleRow}>
          <span className={styles.badge}>{t("permission.requestBadge")}</span>
          <span className={styles.tool}>{request.displayName}</span>
        </div>
        {request.description !== null ? (
          <p className={styles.requestDescription}>{request.description}</p>
        ) : null}
        {request.blockedPath !== null ? (
          <p className={styles.requestBlocked}>{t("permission.blockedPath", { path: request.blockedPath })}</p>
        ) : null}
      </header>

      {/*
       * 入参：等宽、可滚动、**不截断**。等宽是让命令和路径里的字符各就各位 ——
       * 一个被折行的长命令，用比例字体会看不出哪里是空格哪里是换行。
       */}
      <pre className={styles.requestInput}>{formatInput(request.input)}</pre>

      <footer className={styles.requestFooter}>
        <button
          type="button"
          className={styles.denyButton}
          disabled={busy !== null}
          onClick={() => choose("user_reject", "deny")}
        >
          {t("permission.deny")}
        </button>
        <div className={styles.requestActions}>
          <button
            type="button"
            className={styles.alwaysButton}
            disabled={busy !== null}
            title={t("permission.alwaysHint")}
            onClick={() => choose("user_permanent", "always")}
          >
            {t("permission.always")}
          </button>
          <button
            type="button"
            className={styles.allowButton}
            disabled={busy !== null}
            onClick={() => choose("user_temporary", "allow-once")}
          >
            {t("permission.allowOnce")}
          </button>
        </div>
      </footer>
    </section>
  );
}