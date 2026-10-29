import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { CheckIcon } from "../../components/icons.tsx";
import { useT } from "../../lib/app-state.ts";
import styles from "./PermissionModeSwitch.module.css";

/**
 * 权限模式的取值。与 `server/src/agent/controls.ts` 的 `PERMISSION_MODES` 一一对应。
 *
 * `manual` 不出现在这里：它只是 `default` 在 `--help` 里的展示别名，不是第七个值。
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "auto"
  | "bypassPermissions";

export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "bypassPermissions",
];

/** 每种模式的一句话说明，以及它有多危险。 */
interface ModeMeta {
  /** 展示名。`default` 标注为「默认（Manual）」，因为 CLI 里 manual 是它的别名。 */
  label: string;
  /** 一句话说清这个模式会让工具怎么办。 */
  hint: string;
  /**
   * `danger` 的模式必须二次确认；`warn` 的模式在激活期间常驻提示。
   * `null` 表示不需要额外提示。
   */
  risk: "danger" | "warn" | null;
}

export const PERMISSION_MODE_META: Record<PermissionMode, ModeMeta> = {
  default: {
    label: "默认（Manual）",
    hint: "危险操作会停下来问你",
    risk: null,
  },
  acceptEdits: {
    label: "接受编辑",
    hint: "自动接受文件修改，其它操作仍然问",
    risk: "warn",
  },
  plan: {
    label: "计划模式",
    hint: "只做计划，不动手改任何东西",
    risk: null,
  },
  dontAsk: {
    label: "不询问",
    hint: "不弹窗；未预先授权的一律拒绝（比默认更严格）",
    risk: "warn",
  },
  auto: {
    label: "自动",
    hint: "由模型判断哪些操作可以自动批准",
    risk: "warn",
  },
  bypassPermissions: {
    label: "跳过全部检查",
    hint: "所有工具都直接执行，不再询问你",
    risk: "danger",
  },
};

export interface PermissionModeSwitchProps {
  /** 当前模式。null 表示还不知道（进程没起来）。 */
  mode: PermissionMode | null;
  /** 切换。返回前 UI 会先做二次确认（仅 danger 模式）。 */
  onChange(mode: PermissionMode): void;
  /** 不可用时（没有活着的会话）置灰。 */
  disabled?: boolean;
}

/**
 * 权限模式切换。
 *
 * **这是本项目在权限这块能提供的最实在的东西。** 实测 Claude Code CLI 2.1.309 不把
 * 权限提问交给外部进程（见 PROJECT_RULES.md 5.5），所以我们没法弹「允许/拒绝」卡片；
 * 我们能做的是让用户**一眼看清自己现在在哪个模式**，并且切到危险模式时拦住一次。
 *
 * 两条硬约束体现在代码里：
 * - `bypassPermissions` 需要二次确认，确认文案会说明后果（不是「确定吗？」这种废话）。
 * - 激活 `bypassPermissions` / `auto` / `acceptEdits` 期间，调用方应显示常驻横幅
 *   （`permissionBanner()` 给出文案）。
 */
export function PermissionModeSwitch({ mode, onChange, disabled = false }: PermissionModeSwitchProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** 待确认的危险模式。非 null 时弹确认层。 */
  const [pendingDanger, setPendingDanger] = useState<PermissionMode | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const current = mode === null ? null : PERMISSION_MODE_META[mode];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = (next: PermissionMode): void => {
    setOpen(false);
    if (next === mode) return;
    // 危险模式必须再问一次。其余直接生效。
    if (PERMISSION_MODE_META[next].risk === "danger") {
      setPendingDanger(next);
      return;
    }
    onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % PERMISSION_MODE_ORDER.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(
        (index) => (index - 1 + PERMISSION_MODE_ORDER.length) % PERMISSION_MODE_ORDER.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = PERMISSION_MODE_ORDER[highlight];
      if (target !== undefined) choose(target);
    }
  };

  const riskClass =
    current === null ? null : current.risk === "danger" ? styles.danger : current.risk === "warn" ? styles.warn : null;

  return (
    <span className={styles.anchor} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={clsx(styles.trigger, riskClass)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("permission.mode")}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
          setHighlight(mode === null ? 0 : PERMISSION_MODE_ORDER.indexOf(mode));
        }}
      >
        <span className={styles.dot} data-risk={current?.risk ?? "none"} aria-hidden />
        <span className={styles.label}>{current?.label ?? t("permission.unknown")}</span>
      </button>

      {open ? (
        <div
          className={styles.menu}
          role="listbox"
          aria-label={t("permission.mode")}
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          {PERMISSION_MODE_ORDER.map((value, index) => {
            const meta = PERMISSION_MODE_META[value];
            return (
              <div
                key={value}
                role="option"
                aria-selected={value === mode}
                className={clsx(
                  styles.item,
                  index === highlight && styles.itemActive,
                  meta.risk === "danger" && styles.itemDanger,
                )}
                onPointerEnter={() => setHighlight(index)}
                onClick={() => choose(value)}
              >
                <span className={styles.itemMain}>
                  <span className={styles.itemLabel}>{meta.label}</span>
                  <span className={styles.itemHint}>{meta.hint}</span>
                </span>
                {value === mode ? <CheckIcon /> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {pendingDanger !== null ? (
        <div className={styles.confirmOverlay} role="dialog" aria-modal="true">
          <div className={styles.confirmBox}>
            <div className={styles.confirmTitle}>
              {t("permission.confirmBypassTitle")}
            </div>
            <p className={styles.confirmBody}>{t("permission.confirmBypassBody")}</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmCancel}
                onClick={() => setPendingDanger(null)}
              >
                {t("permission.cancel")}
              </button>
              <button
                type="button"
                className={styles.confirmDanger}
                onClick={() => {
                  onChange(pendingDanger);
                  setPendingDanger(null);
                }}
              >
                {t("permission.confirmBypassAction")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/**
 * 当前模式需要常驻提示时的文案。
 *
 * 返回 null 表示不需要横幅。危险模式（`bypassPermissions`）用 `danger`，
 * 其余放宽要求的模式用 `warn`。
 */
export function permissionBanner(
  mode: PermissionMode | null,
): { level: "warn" | "danger"; text: string } | null {
  if (mode === null) return null;
  const meta = PERMISSION_MODE_META[mode];
  if (meta.risk === "danger") {
    return {
      level: "danger",
      text: "跳过全部检查已开启：所有工具都会直接执行，不再询问你。用完请切回「默认」。",
    };
  }
  if (meta.risk === "warn") {
    return { level: "warn", text: `${meta.label}：${meta.hint}。` };
  }
  return null;
}
