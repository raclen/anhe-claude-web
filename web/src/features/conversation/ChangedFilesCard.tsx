import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Translate } from "../../lib/i18n/index.ts";
import { ChevronIcon } from "../../components/icons.tsx";
import { DiffIcon, ExternalIcon, FileIcon } from "../rightbar/rightbar-icons.tsx";
import { parseUnifiedDiff } from "../rightbar/diff-parse.ts";
import type { TurnFile } from "./turn-files.ts";
import styles from "./ChangedFilesCard.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * Rows shown before the fold: dsh's summary height for a closing message, and
 * enough that a turn's ordinary one-to-three file change needs no second click.
 */
const COLLAPSED_ROWS = 4;

/** dsh opens a row's comparison after half a second of hover, not on contact. */
const PREVIEW_DELAY_MS = 500;

/**
 * Room a comparison needs above the card before it opens upward.
 *
 * The panel's own cap (320px of body plus its path line) and a little air. dsh
 * lets its HoverCard pick a side from the measured space; this is the same
 * decision made from one number, because the transcript's scrollport is the only
 * thing the panel can escape into and it is always vertical.
 */
const PREVIEW_ROOM_PX = 372;

/** dsh groups its line counts; a turn that adds 1200 lines says so readably. */
const GROUPED = new Intl.NumberFormat("en-US");

/** The last segment of a path, either separator — what a one-file header is named. */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Added and deleted line counts in the card's two colors, as dsh draws them. */
function Counts({ added, deleted, t }: { added: number; deleted: number; t: Translate }) {
  return (
    <>
      <span className={styles.added}>{t("editedFiles.added", { count: GROUPED.format(added) })}</span>
      <span className={styles.deleted}>{t("editedFiles.deleted", { count: GROUPED.format(deleted) })}</span>
    </>
  );
}

/** The counts one file shows, or the reason it has none. */
function fileCounts(file: TurnFile, t: Translate) {
  if (file.oversized && file.added + file.deleted === 0) {
    return <span>{t("editedFiles.oversized")}</span>;
  }
  return <Counts added={file.added} deleted={file.deleted} t={t} />;
}

/**
 * The files a turn wrote, as a card at the turn's tail.
 *
 * Every row opens the turn's review in the right sidebar, on that file — dsh's
 * card does the same (`openReview(index)`), and the review is where the
 * comparison, the other files of the turn, and the way into the whole file all
 * live. The transcript already says a `write` happened; what a reader wants next
 * is the change, not the tool row's argument summary. A row is a button whenever
 * the sidebar can be addressed, including a file outside the project: its patch
 * is in the transcript like any other, and only the review's "open the whole
 * file" control needs a project-relative path.
 *
 * A single-file turn keeps only the header, the way dsh does: the file's name is
 * the whole title, so a list of one would repeat it. Multi-file turns carry the
 * per-file counts and a hover comparison, and hold their rows to four before the
 * fold.
 */
export function ChangedFilesCard({
  files,
  turn,
  onOpenChanges,
  onOpenFile,
}: {
  files: readonly TurnFile[];
  /** The turn these files belong to — what a review tab is addressed by. */
  turn: number;
  /** Absent when the sidebar cannot be addressed (no session path yet). */
  onOpenChanges?: ((turn: number, index: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  /** Index of the file whose comparison is open, or null while none is. */
  const [preview, setPreview] = useState<number | null>(null);
  /** True when the comparison is placed under the card instead of over it. */
  const [below, setBelow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const single = files.length === 1 ? files[0] : undefined;
  const foldable = files.length > COLLAPSED_ROWS;
  const rows = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;
  const added = files.reduce((total, file) => total + file.added, 0);
  const deleted = files.reduce((total, file) => total + file.deleted, 0);

  const openable = onOpenChanges !== undefined;
  /** Open the file in the right sidebar's Preview tab, falling back to turn diff. */
  const previewAt = (index: number): void => {
    cancelPreview();
    const file = files[index];
    if (file?.relative && onOpenFile) {
      onOpenFile(file.relative);
      return;
    }
    onOpenChanges?.(turn, index);
  };

  /** Open the turn's diff review on one file in the right sidebar. */
  const reviewDiffAt = (index: number): void => {
    cancelPreview();
    onOpenChanges?.(turn, index);
  };

  const cancelPreview = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setPreview(null);
  };
  /** A row arms the comparison half a second in, so passing over the card costs nothing. */
  const armPreview = (index: number): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (files[index]?.patches.length === 0) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      // Scrollport top, not window top: the transcript scrolls inside its own
      // box, and a panel that clears the window can still be clipped by it.
      setBelow((rootRef.current?.getBoundingClientRect().top ?? 0) < PREVIEW_ROOM_PX);
      setPreview(index);
    }, PREVIEW_DELAY_MS);
  };
  const hoverProps = (file: TurnFile, index: number) =>
    file.patches.length === 0
      ? {}
      : {
          onMouseEnter: () => armPreview(index),
          onMouseLeave: cancelPreview,
          onFocus: () => armPreview(index),
          onBlur: cancelPreview,
        };

  const headline = single === undefined ? t("editedFiles.title", { count: files.length }) : null;
  const header = (
    <>
      <span className={styles.tile}>
        {single === undefined ? (
          <DiffIcon width={18} height={18} />
        ) : (
          <FileIcon width={18} height={18} />
        )}
      </span>
      <span className={styles.titles}>
        <span className={styles.title}>
          {single === undefined
            ? headline
            : t("editedFiles.singleTitle", { name: basename(single.display) })}
        </span>
        <span className={styles.stat}>
          <span className={styles.statCounts}>
            {single === undefined ? (
              <Counts added={added} deleted={deleted} t={t} />
            ) : (
              fileCounts(single, t)
            )}
          </span>
          <span className={styles.previewHint}>{t("editedFiles.previewHint")}</span>
        </span>
      </span>
    </>
  );

  const headerLabel =
    single === undefined
      ? t("editedFiles.reviewAll")
      : t("editedFiles.viewDiff", { name: single.display });

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-turn-files
      data-single={single !== undefined || undefined}
      data-place={below ? "below" : "above"}
    >
      <div className={styles.card}>
        {single !== undefined ? (
          <div className={styles.header}>
            {openable || (single.relative && onOpenFile) ? (
              <button
                type="button"
                className={styles.headerMain}
                aria-label={
                  single.relative && onOpenFile
                    ? t("turnChanges.openFileAria", { name: single.display })
                    : headerLabel
                }
                title={
                  single.relative && onOpenFile
                    ? t("turnChanges.openFileAria", { name: single.display })
                    : single.path
                }
                onClick={() => previewAt(0)}
                {...hoverProps(single, 0)}
              >
                <span className={styles.tile}>
                  <FileIcon width={18} height={18} />
                </span>
                <span className={styles.titles}>
                  <span className={styles.title}>
                    {t("editedFiles.singleTitle", { name: basename(single.display) })}
                  </span>
                  <span className={styles.stat}>
                    <span className={styles.statCounts}>{fileCounts(single, t)}</span>
                    <span className={styles.previewHint}>
                      {single.relative && onOpenFile
                        ? t("turnChanges.openFile")
                        : t("editedFiles.previewHint")}
                    </span>
                  </span>
                </span>
              </button>
            ) : (
              <>
                <span className={styles.tile}>
                  <FileIcon width={18} height={18} />
                </span>
                <span className={styles.titles}>
                  <span className={styles.title}>
                    {t("editedFiles.singleTitle", { name: basename(single.display) })}
                  </span>
                  <span className={styles.stat}>
                    <span className={styles.statCounts}>{fileCounts(single, t)}</span>
                  </span>
                </span>
              </>
            )}

            <div className={styles.headerActions}>
              {openable ? (
                <button
                  type="button"
                  className={styles.headerActionBtn}
                  title={t("editedFiles.viewDiff", { name: single.display })}
                  aria-label={t("editedFiles.viewDiff", { name: single.display })}
                  onClick={(e) => {
                    e.stopPropagation();
                    reviewDiffAt(0);
                  }}
                >
                  <DiffIcon width={15} height={15} />
                </button>
              ) : null}
              {single.relative && onOpenFile ? (
                <button
                  type="button"
                  className={styles.headerActionBtn}
                  title={t("turnChanges.openFile")}
                  aria-label={t("turnChanges.openFileAria", { name: single.display })}
                  onClick={(e) => {
                    e.stopPropagation();
                    previewAt(0);
                  }}
                >
                  <ExternalIcon width={14} height={14} />
                </button>
              ) : null}
            </div>
          </div>
        ) : openable ? (
          <button
            type="button"
            className={styles.header}
            aria-label={headerLabel}
            onClick={() => reviewDiffAt(0)}
          >
            {header}
          </button>
        ) : (
          <div className={styles.header}>{header}</div>
        )}

        {single === undefined ? (
          <ul className={styles.list}>
            {rows.map((file) => {
              const index = files.indexOf(file);
              const label = <span className={styles.path}>{file.display}</span>;
              const badge = <span className={styles.counts}>{fileCounts(file, t)}</span>;
              const hover = hoverProps(file, index);
              const canPreview = Boolean(file.relative && onOpenFile);
              return (
                <li key={file.path} className={styles.rowItem}>
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.rowMain}
                      title={
                        canPreview
                          ? t("turnChanges.openFileAria", { name: file.display })
                          : file.path
                      }
                      aria-label={
                        canPreview
                          ? t("turnChanges.openFileAria", { name: file.display })
                          : file.display
                      }
                      onClick={() => previewAt(index)}
                      {...hover}
                    >
                      {label}
                    </button>
                    <div className={styles.rowActions}>
                      {openable ? (
                        <button
                          type="button"
                          className={styles.rowBadge}
                          title={t("editedFiles.viewDiff", { name: file.display })}
                          aria-label={t("editedFiles.viewDiff", { name: file.display })}
                          onClick={(e) => {
                            e.stopPropagation();
                            reviewDiffAt(index);
                          }}
                        >
                          {badge}
                        </button>
                      ) : (
                        badge
                      )}
                      {canPreview ? (
                        <button
                          type="button"
                          className={styles.previewBtn}
                          title={t("turnChanges.openFile")}
                          aria-label={t("turnChanges.openFileAria", { name: file.display })}
                          onClick={(e) => {
                            e.stopPropagation();
                            previewAt(index);
                          }}
                        >
                          <ExternalIcon width={12} height={12} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {foldable ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("editedFiles.collapseAll")
                : t("editedFiles.expandAll", { count: files.length })
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <span>
              {expanded ? t("common.collapse") : t("editedFiles.showAll", { count: files.length })}
            </span>
            <ChevronIcon width={14} height={14} />
          </button>
        ) : null}
      </div>

      {preview === null || files[preview] === undefined ? null : (
        <ChangedFilePreview file={files[preview] as TurnFile} t={t} />
      )}
    </div>
  );
}

/**
 * The comparison a hovered file opens, drawn inside the card and over the rows
 * above it.
 *
 * The lines come from pi's own patches — the same text the counts were parsed
 * from — so the header can never claim `+3 -1` over a diff showing something
 * else. dsh hides the hunk headers in this preview because the panel it opens is
 * one click away; this one does the same, and keeps only the lines that carry
 * the change.
 */
function ChangedFilePreview({ file, t }: { file: TurnFile; t: Translate }) {
  const hunks = useMemo(
    () => file.patches.flatMap((patch) => parseUnifiedDiff(patch).hunks),
    [file.patches],
  );

  return (
    <div className={styles.preview} data-turn-files-preview>
      <div className={styles.previewPath}>{file.display}</div>
      <div className={styles.previewBody}>
        {hunks.map((hunk, hunkIndex) => (
          <Fragment key={`${String(hunkIndex)}:${hunk.header}`}>
            {hunk.lines.map((line, lineIndex) =>
              line.kind === "meta" ? null : (
                <div
                  className={`${styles.line} ${line.kind === "add" ? styles.lineAdd : line.kind === "del" ? styles.lineDel : ""}`}
                  key={`${String(lineIndex)}:${line.text}`}
                >
                  <span className={styles.marker}>
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  <span className={styles.lineText}>{line.text}</span>
                </div>
              ),
            )}
          </Fragment>
        ))}
        {hunks.length === 0 ? <div className={styles.previewNote}>{t("editedFiles.oversized")}</div> : null}
      </div>
    </div>
  );
}
