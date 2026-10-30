import clsx from "clsx";
import { useT } from "../../lib/app-state.ts";
import styles from "./PermissionCard.module.css";

/**
 * 工具调用被**拒绝之后**的那张说明卡。
 *
 * 别和 `PermissionRequestCard` 搞混：那张是**正在发生的提问**（三个按钮，
 * 由 `--permission-prompt-tool` 的内置 MCP 中继送来），这张是**已经发生的事实**。
 * 走到这里的典型情况是 CLI 自己按 `settings.json` 的规则直接拒了、或者用户在中继
 * 里点了拒绝 —— 那时没有按钮可点，能做的只有把原始原因摆清楚。
 *
 * 含糊其辞（「操作已取消」）会让用户以为程序坏了；把原因摊开，用户才知道要么换
 * 模式、要么改规则、要么换命令。
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
