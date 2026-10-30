/**
 * Runtime vocabulary derived from the persisted work-details mode, ported from
 * dsh's `ui-chat` presentation policy. Renderers select single fields instead
 * of comparing the mode enum, so adding a mode changes only the table below.
 */

import type { TranscriptDisplay } from "../../lib/types.ts";

/** Presentation capabilities that one work-details mode enables. */
export interface TranscriptPolicy {
  /**
   * Whether a normally completed turn folds its process rows behind the
   * whole-turn completion header (dsh's `foldCompletedTurns`).
   */
  foldCompletedTurns: boolean;
  /**
   * Whether a turn's process rows fold into per-stretch groups, and for which
   * turns — dsh's `stepGrouping`: every turn (`collapsed`), closed turns only
   * (`history`), or none (`none`).
   */
  stepGrouping: "collapsed" | "history" | "none";
  /**
   * Whether a live group's title carries the running tool's argument (a
   * command, a path, a query) — dsh's `liveProcessDetail`.
   */
  liveProcessDetail: boolean;
  /**
   * Whether a settled reasoning row previews its first line beside the Think
   * title (dsh's `settledReasoningPreview`).
   */
  settledReasoningPreview: boolean;
  /**
   * Whether reasoning is cut out of the tool group and listed on its own.
   *
   * 「简洁」和「标准」原来只差这一个字段和一个只在思考行露面时才看得见的摘要：
   * 两个档位都把思考折进工具组里，思考行根本不出现，于是「标准」看起来和「简洁」
   * 一模一样。既然设置项的名字就是「对话显示」，标准档就必须有一处看得见的区别 ——
   * 所以从标准起，思考单列成行，工具调用继续折进「已完成，用时 X秒」里。
   */
  separateReasoning: boolean;
  /**
   * Whether a reasoning row's body starts open instead of collapsed.
   *
   * dsh always mounts its reasoning rows closed, and the modes ported from it
   * inherit that. 标准档要的是「一眼看到有这么一段推理」，不是「一眼读完推理」，
   * 所以它仍然折叠；把正文一并摊开是「完全展开」的意思。
   */
  reasoningExpanded: boolean;
  /**
   * Whether a reasoning row renders as a card — its own rounded, tinted block
   * with the summary on top and the reasoning text underneath — instead of the
   * bare "思考 · 一行摘要" line that shares the tool rows' shape.
   *
   * 一行「思考 · 摘要」和一行 `read foo.ts` 长得一模一样，读的人分不出哪行是模型
   * 在想、哪行是它在动手。标准档正是「要看见推理」的第一档，所以从标准起思考换成
   * 一张卡片：灯泡图标 + 摘要 + 用时，默认折叠，点开读全文。
   */
  reasoningCard: boolean;
  /**
   * Whether a tool call row starts with its input/output card open.
   *
   * 标准与详细都只让工具行本身露面（一行摘要，写着读了哪个文件、跑了什么命令），
   * 参数与输出仍然一次点击之遥 —— 那才是这两个档位说的「细节」。
   * 「完全展开」是唯一把 I/O 也一并摊开的档位。
   */
  toolExpanded: boolean;
}

const POLICIES: Readonly<Record<TranscriptDisplay, TranscriptPolicy>> = {
  // 简洁：思考也折进工具组，连一行摘要都不给。
  compact: {
    foldCompletedTurns: true,
    stepGrouping: "collapsed",
    liveProcessDetail: false,
    settledReasoningPreview: false,
    separateReasoning: false,
    reasoningExpanded: false,
    reasoningCard: false,
    toolExpanded: false,
  },
  // 标准：执行过程不再折叠 —— 每一个工具调用行（Bash / Edit / Read…）都平铺在
  // 转录里看得见，各带一行摘要；思考折成一张卡片（灯泡 + 摘要 + 用时），默认收起。
  // 这是它和「简洁」之间唯一、但看得见的区别。
  standard: {
    foldCompletedTurns: false,
    stepGrouping: "none",
    liveProcessDetail: true,
    settledReasoningPreview: true,
    separateReasoning: true,
    reasoningExpanded: false,
    reasoningCard: true,
    toolExpanded: false,
  },
  // 详细档：在「标准」的平铺之上把思考正文也摊开 —— 工具行同样平铺可见，
  // 只是参数与输出仍然一次点击之遥（那是「完全展开」的事）。
  detailed: {
    foldCompletedTurns: false,
    stepGrouping: "none",
    liveProcessDetail: true,
    settledReasoningPreview: true,
    separateReasoning: true,
    reasoningExpanded: true,
    reasoningCard: true,
    toolExpanded: false,
  },
  verbose: {
    foldCompletedTurns: false,
    stepGrouping: "none",
    liveProcessDetail: false,
    settledReasoningPreview: true,
    separateReasoning: true,
    reasoningExpanded: true,
    reasoningCard: true,
    toolExpanded: true,
  },
};

/**
 * Resolve the policy constant for one mode. The same mode always yields the same
 * object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @returns the mode's presentation policy.
 */
export function transcriptPolicyFor(mode: TranscriptDisplay): TranscriptPolicy {
  return POLICIES[mode];
}
