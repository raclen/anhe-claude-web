import { useEffect, useMemo, useState } from "react";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { StateDot } from "../../components/StateDot.tsx";
import type { ContentBlock, TextBlock, ToolCallBlock } from "../../lib/types.ts";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { ImageThumb } from "../../components/ImageLightbox.tsx";
import { imageBlocksOf } from "../../lib/image-attachments.ts";
import { classify, deriveSummary, shortenPath, type Variant } from "./row-model.ts";
import { parseMcpToolName, toolRowTitle } from "./tool-map.ts";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./ToolCallRow.module.css";
import { useT } from "../../lib/app-state.ts";

/** Variant → glyph. The UI half of the variant table; the rest lives in row-model. */
const VARIANT_GLYPHS: Record<Variant, GlyphName> = {
  bash: "terminal",
  read: "browse",
  write: "edit",
  edit: "edit",
  search: "search",
  code: "code",
  others: "sparkle",
};

/**
 * The textual half of a tool's answer.
 *
 * Images are left out rather than rendered as `[image]`: they are shown as
 * pictures below this text (see `ioImages`), and a marker next to the picture
 * that stands for it is noise.
 */
function blocksToText(blocks: ContentBlock[] | null): string {
  if (!blocks) return "";
  return blocks
    .filter((block) => block.type !== "image")
    .map((block) => (block.type === "text" ? (block as TextBlock).text : `[${block.type}]`))
    .join("\n");
}

/**
 * The input side, trimmed to what the row is about rather than a JSON dump.
 * A shell command is the whole story; for everything else the arguments are.
 */
function inputText(variant: Variant, call: ToolCallBlock): string {
  const args = call.arguments;
  if (!args || Object.keys(args).length === 0) return "";
  if (variant === "bash" && typeof args.command === "string") return `$ ${args.command}`;
  return JSON.stringify(args, null, 2);
}

/**
 * One tool call as a dsh-style disclosure row.
 *
 * Collapsed it is a single 24px line: glyph, name, a 2×2 dot, then the summary.
 * Expanded it grows an I/O card with the arguments on top and the output below.
 * There is no separate chevron column — hovering cross-fades the glyph into a
 * chevron in place, which is what keeps a list of these as tight as a paragraph.
 */
export function ToolCallRow({
  call,
  execution,
  cwd,
  home,
  defaultOpen = false,
}: {
  call: ToolCallBlock;
  execution: ToolExecution | undefined;
  cwd?: string | undefined;
  home?: string | undefined;
  /** Whether the I/O card starts open; the 「完全展开」档 asks for it. */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  // 档位给的初值，之后由用户点击接管；档位一变就按新档位重新摆正，
  // 否则已经点开过的行会一直开着，让「详细」看起来和「完全展开」一样。
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  const variant = classify(call.name);
  const state = execution?.isError ? "error" : execution?.running ? "running" : "ok";
  const running = execution?.running ?? false;
  // Paths dominate these rows and pi hands them over absolute, so the summary
  // gets the same workspace-then-home treatment dsh applies.
  const summary = shortenPath(deriveSummary(variant, call.arguments ?? execution?.args), cwd, home);
  const output = execution?.output || blocksToText(execution?.result ?? null);
  const images = imageBlocksOf(execution?.result ?? []);
  const input = useMemo(() => inputText(variant, call), [variant, call]);
  const showInput = input.length > 0 || running;
  // Bash 的摘要优先取 `description`（自然语言，比如「查看构建配置」），只有没有
  // description 时才是命令本身。等宽字体只对后者有意义 —— 中文描述用等宽反而难读。
  const args = call.arguments ?? execution?.args;
  const summaryIsCommand =
    variant === "bash" && typeof args?.command === "string" && typeof args?.description !== "string";

  // 标题用**真实工具名**（`Bash` / `Edit` / `Read`），不再按 variant 翻成
  // 「命令 / 编辑 / 读取」：一段转录里常混着几个不同工具，中文 variant 词会让
  // 它们看起来是同一件事。MCP 工具（`mcp__chrome-devtools__click`）的名字里本来
  // 就同时带着 server 和工具，两段都要露出来，否则「chrome-devtools」整个消失。
  const mcp = parseMcpToolName(call.name);
  const { label: rawLabel, server } = toolRowTitle(call.name);
  // 历史转录里存在工具名为空的块（CLI 没能解析出 tool_use 的 name，参数只剩
  // `__unparsedToolInput`）。标题空着只剩一个图标，看起来像渲染坏了，所以退回
  // 通用文案 —— 展开后的输入区仍然把原始内容摊给用户看。
  const toolLabel = rawLabel === "" ? t("tool.others") : rawLabel;
  // MCP 工具没有自己的 variant 图标（会被归到 search），换个通用的插件图标更贴切。
  const glyph = mcp !== undefined ? "mcp" : VARIANT_GLYPHS[variant];

  return (
    <div className={styles.root} data-variant={variant} data-tool={call.name} data-state={state}>
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        // dsh swaps the glyph for a state dot when a call did not settle cleanly.
        icon={state === "error" ? <StateDot state="error" /> : <Glyph name={glyph} />}
        title={
          <span className={styles.titleInner}>
            {server !== undefined ? (
              <span className={styles.server} title={call.name}>
                {server}
              </span>
            ) : null}
            <span className={styles.toolName}>{toolLabel}</span>
          </span>
        }
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            {/* 没有摘要的调用（`take_snapshot` 这种无参工具）不画分隔点：行尾挂一颗
                孤零零的「·」看起来像渲染漏了东西。 */}
            {summary !== "" ? <span className={styles.sep} aria-hidden /> : null}
            <span
              className={styles.summary}
              data-mono={summaryIsCommand || undefined}
              data-error={execution?.isError || undefined}
            >
              {summary}
            </span>
          </>
        }
      >
        <div className={styles.bodyScroll}>
          <div className={styles.ioCard}>
            {showInput ? (
              <>
                <div className={styles.ioSection}>
                  <span className={styles.ioLabel}>{t("toolCall.input")}</span>
                  <span className={styles.ioText}>{input || t("common.runningEllipsis")}</span>
                </div>
                <div className={styles.ioDivider} />
              </>
            ) : null}
            <div className={styles.ioSection}>
              <span className={styles.ioLabel}>{t("toolCall.output")}</span>
              {output.length > 0 || running || images.length === 0 ? (
                <span className={styles.ioText} data-error={execution?.isError || undefined}>
                  {output.length > 0 ? output : running ? t("common.runningEllipsis") : t("toolCall.noOutput")}
                </span>
              ) : null}
              {/* A picture from `read` is the answer itself, not a value for the
                  label beside it, so it spans the section's two columns. */}
              {images.length > 0 ? (
                <div className={styles.ioImages}>
                  {images.map((image, index) => (
                    <ImageThumb
                      key={index}
                      image={image}
                      variant="tool"
                      alt={t("toolCall.resultImage", { index: index + 1 })}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
}
