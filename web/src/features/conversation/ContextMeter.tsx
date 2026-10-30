import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { formatTokens } from "../../lib/duration.ts";
import type { ComposerContext } from "../../lib/types.ts";
import { StatPanel, StatRow } from "./StatPanel.tsx";
import styles from "./ContextMeter.module.css";
import { useT } from "../../lib/app-state.ts";

/** Radius and circumference of the ring in its 16px viewBox. */
const RADIUS = 6.4;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextMeterProps {
  context: ComposerContext | null;
  /** 打开面板时刷新 CLI 上下文；仅用户主动查询时才允许启动未驻留的会话。 */
  onRequestLive(): void;
}

/**
 * How full the context window is, as a ring next to the send button.
 *
 * The ring is a progress arc rather than a number because it sits in a toolbar
 * where horizontal space is contested: the figure itself is one click away in the
 * panel, and the shape answers "am I near the limit?" without being read.
 *
 * 没有已知窗口时不画占用弧线，但面板仍展示已知的历史 token 数。
 * 实时查询与历史 usage 分开标注，避免把缺失窗口误报成整个会话没有用量。
 */
export function ContextMeter({ context, onRequestLive }: ContextMeterProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Same dismissal contract as the stat pills: outside pointer or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (context === null) {
    return (
      <span className={styles.anchor} ref={rootRef}>
        <button
          type="button"
          className={styles.button}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("context.unknown")}
          title={t("context.unknown")}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onRequestLive();
          }}
        >
          <Ring percent={null} />
        </button>
        {open ? (
          <StatPanel align="end" icon={<Ring percent={null} />} title={t("context.title")} note={t("context.emptyNote")}>
            <StatRow label={t("context.window")} value={t("context.unknownValue")} />
          </StatPanel>
        ) : null}
      </span>
    );
  }

  const percent = context.percent;
  const windowKnown = context.contextWindow > 0;
  const label = context.tokens === null
    ? t("context.unknown")
    : context.source === "usage"
      ? t("context.usageOnly", { used: formatTokens(context.tokens) })
      : t("context.breakdown", {
          percent: percent === null ? t("context.unknownValue") : formatPercent(percent),
          used: formatTokens(context.tokens),
          window: formatTokens(context.contextWindow),
        });

  return (
    <span className={styles.anchor} ref={rootRef}>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onRequestLive();
        }}
      >
        <Ring percent={percent} />
      </button>
      {open ? (
        <StatPanel
          align="end"
          icon={<Ring percent={percent} />}
          title={t("context.title")}
          value={
            context.tokens === null
              ? undefined
              : windowKnown
                ? `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
                : `${formatTokens(context.tokens)} tok`
          }
          note={t(context.source === "live" ? "context.note" : "context.usageNote")}
        >
          <StatRow label={t("context.window")} value={windowKnown ? `${formatTokens(context.contextWindow)} tok` : t("context.unknownValue")} />
          <StatRow
            label={t("context.used")}
            value={
              context.tokens === null
                ? t("context.unknownValue")
                : percent === null
                  ? `${formatTokens(context.tokens)} tok`
                  : `${formatTokens(context.tokens)} tok（${formatPercent(percent)}%）`
            }
          />
          <StatRow
            label={t("context.remaining")}
            value={
              context.tokens === null || !windowKnown
                ? t("context.unknownValue")
                : `${formatTokens(Math.max(0, context.contextWindow - context.tokens))} tok`
            }
          />
        </StatPanel>
      ) : null}
    </span>
  );
}

/**
 * Whole percents from ten up, one decimal below — the same shape dsh uses for
 * its cache-hit figure, and the same reason: rounding 0.6% to "1%" overstates
 * what was used, while rounding it to "0%" claims nothing was.
 */
function formatPercent(percent: number): string {
  const clamped = Math.max(0, percent);
  if (clamped > 0 && clamped < 1) return "<1";
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * The ring itself. `percent === null` draws the track only, which is how "no
 * figure" looks: an empty gauge, not a full one.
 */
function Ring({ percent }: { percent: number | null }) {
  const shown = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const tone =
    shown >= 90 ? styles.ringCritical : shown >= 75 ? styles.ringWarning : undefined;
  return (
    <svg
      className={clsx(styles.ring, tone)}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle
        className={styles.track}
        cx={8}
        cy={8}
        r={RADIUS}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      {shown > 0 ? (
        <circle
          cx={8}
          cy={8}
          r={RADIUS}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${(CIRCUMFERENCE * shown) / 100} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  );
}
