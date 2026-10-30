import { useEffect, useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { firstNonBlankLine, lastNonBlankLine } from "./row-model.ts";
import { formatRunDuration } from "../../lib/duration.ts";
import styles from "./ThinkingBlock.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * One reasoning block as dsh's Think row.
 *
 * The collapsed summary is deliberately line-dependent: while the block is
 * still streaming it tracks the *last* line with content, so the row reads as
 * live output rather than freezing on a sentence written thirty seconds ago.
 * Once settled it snaps back to the first line with content, which is the one
 * that states the intent. Blank lines are skipped either way — a reasoning
 * block routinely opens with one, and "思考 ·" with nothing after the dot looks
 * like a bug.
 *
 * `data-follow-end` drives the streaming case: the text is right-aligned and
 * allowed to overflow to the left, so new words appear at the trailing edge
 * instead of the whole line re-ellipsising on every token.
 *
 * `preview` is dsh's `settledReasoningPreview`: a *settled* row only carries its
 * one-line summary where the display policy asks for one. While the block is
 * still streaming the preview is unconditional — that text is the only sign of
 * what the model is doing — so a policy that turns previews off cannot take the
 * live line away. It is a `data-` flag rather than a conditional render so the
 * summary span keeps its identity as the policy flips.
 *
 * `card` swaps the bare "思考 · 摘要" line for a card: same summary on the
 * header, the reasoning text below it, both inside one rounded, tinted block.
 * The bare row is indistinguishable from a tool row at a glance, and the modes
 * that promise to show the reasoning are exactly the ones where that matters —
 * see `TranscriptPolicy.reasoningCard`.
 */
export function ThinkingBlock({
  text,
  durationMs,
  streaming,
  preview = true,
  defaultOpen = false,
  card = false,
}: {
  text: string;
  /**
   * How long this block streamed, when this browser measured it.
   *
   * Absent for a transcript read back from disk — the protocol carries no
   * per-block timing — and absent is the honest answer there: no chip at all
   * rather than a number that was never measured. See
   * `ThinkingBlock.thinkingMs` in `lib/types.ts`.
   */
  durationMs?: number | undefined;
  streaming?: boolean;
  /** Whether a settled row may show its one-line summary. */
  preview?: boolean;
  /** Whether the body starts open rather than collapsed. */
  defaultOpen?: boolean;
  /** Render as a card rather than a plain disclosure row. */
  card?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);

  // `defaultOpen` 是显示档位给的初值，之后由用户点击接管：档位一变（比如从
  // 「完全展开」切回「标准」）就重新按档位摆正，否则已经点开过的行会一直开着，
  // 让折叠档位看起来和「完全展开」一样。
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  // pi emits empty reasoning blocks — interrupted thinking, or a turn where the
  // model returned none. An empty "思考 ·" row is pure noise, and the same guard
  // keeps the row from flickering in for a frame at the start of a stream.
  if (text.trim() === "") return null;

  const running = streaming ?? false;
  const summary = (running ? lastNonBlankLine(text) : firstNonBlankLine(text)).replaceAll("**", "");
  const showsPreview = summary !== "" && (running || preview);
  // 时长只在「已经跑完且本浏览器真的量过」时出现：流式中显示它等于每帧都在变，
  // 回读的会话则根本没有这个数字。不足一秒的推理不挂数字 —— 整轮时长的「至少按
  // 1 秒算」是为了别出现「0秒」，而这里本来就没什么可读的。
  const duration =
    !running && durationMs !== undefined && durationMs >= 1000
      ? formatRunDuration(durationMs, t)
      : null;

  if (card) {
    return (
      <div
        className={styles.card}
        data-variant="think"
        data-state={running ? "running" : "ok"}
        data-expanded={open || undefined}
      >
        {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}
        <div
          className={styles.cardHeader}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setOpen((value) => !value);
          }}
        >
          <span className={styles.cardLeading}>
            <Glyph name="think" />
          </span>
          <span className={styles.cardTitle}>{t("thinking.title")}</span>
          {showsPreview ? (
            <>
              <span className={styles.separator} aria-hidden />
              <span className={styles.summary} data-follow-end={running || undefined}>
                <span className={styles.summaryText}>{summary}</span>
              </span>
            </>
          ) : null}
          {duration === null ? null : <span className={styles.duration}>{duration}</span>}
          <Glyph name="chevronDown" className={styles.cardChevron} />
        </div>
        {open ? <div className={styles.cardBody}>{text}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={styles.root}
      data-variant="think"
      data-state={running ? "running" : "ok"}
      data-expanded={open || undefined}
      data-preview={showsPreview || undefined}
    >
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        icon={<Glyph name="think" />}
        title={t("thinking.title")}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            <span className={styles.separator} aria-hidden />
            <span className={styles.summary} data-follow-end={running || undefined}>
              <span className={styles.summaryText}>{summary}</span>
            </span>
            {duration === null ? null : <span className={styles.duration}>{duration}</span>}
          </>
        }
      >
        <div className={styles.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  );
}
