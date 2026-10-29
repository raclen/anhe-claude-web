import clsx from "clsx";
import { useT } from "../../lib/app-state.ts";
import styles from "./PermissionCard.module.css";

/**
 * 工具调用被拒绝时的那张卡片。
 *
 * **先说清这张卡不是什么。** 它不是一个「允许 / 拒绝」按钮——本项目没有能力弹那种卡。
 * 实测 Claude Code CLI 2.1.309 不把权限提问交给外部进程（`--permission-prompts host`
 * 只会得到一条 `system:permission_denied`；`--sdk-url` 被拒）。
 *
 * 那它是什么：**一条如实的拒绝说明**。CLI 拦下了某个工具，我们把它的原始原因
 * 完整摆出来，并告诉用户三条可走的路。含糊其辞（「操作已取消」）会让用户以为
 * 程序坏了；把原因摊开，用户才知道要么去终端批、要么换模式、要么改命令。
 */
export interface PermissionDeniedProps {
  /** 被拒的工具名。 */
  toolName: string | null;
  /** CLI 给的原始原因。**保持原样，不截断、不改写。** */
  message: string | null;
  /** `decision_reason_type`，用来在标题上区分「规则拦的」还是「路径越界」。 */
  decisionReasonType: string | null;
}

/** 把 `decision_reason_type` 翻成人话。没见过的取值原样显示，不猜。 */
function reasonLabel(type: string | null): string {
  switch (type) {
    case null:
      return "";
    case "subcommandResults":
      return "命令分段审批未通过";
    case "ruleBased":
      return "被权限规则拦下";
    case "pathOutsideWorkingDirectory":
      return "路径在工作目录之外";
    case "mode":
      return "当前权限模式不允许";
    default:
      return type;
  }
}

export function PermissionDeniedCard({
  toolName,
  message,
  decisionReasonType,
}: PermissionDeniedProps) {
  const t = useT();
  const reason = reasonLabel(decisionReasonType);

  return (
    <div className={clsx(styles.card)} role="note">
      <div className={styles.header}>
        <span className={styles.badge}>{t("permission.deniedBadge")}</span>
        <span className={styles.tool}>{toolName ?? t("permission.unknownTool")}</span>
        {reason.length > 0 ? <span className={styles.reason}>{reason}</span> : null}
      </div>

      {/* 原始原因：等宽、可换行、不截断。用户要能读到 CLI 到底说了什么。 */}
      {message !== null && message.length > 0 ? (
        <pre className={styles.raw}>{message}</pre>
      ) : (
        <p className={styles.rawMuted}>{t("permission.noReason")}</p>
      )}

      <div className={styles.help}>
        <span className={styles.helpTitle}>{t("permission.howToAllow")}</span>
        <ul className={styles.helpList}>
          <li>{t("permission.hintTerminal")}</li>
          <li>{t("permission.hintAllowList")}</li>
          <li>{t("permission.hintMode")}</li>
        </ul>
      </div>
    </div>
  );
}
