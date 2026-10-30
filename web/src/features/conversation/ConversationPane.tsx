import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { AlertIcon, RefreshIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import { actions, appStore, isDraftSession, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { rightbarActions, rightbarStore } from "../rightbar/rightbar-state.ts";
import { publishTurnChanges, type TurnChanges } from "../rightbar/turn-changes-store.ts";
import { PanelRightIcon } from "../rightbar/rightbar-icons.tsx";
import { shortcutTitle } from "../rightbar/shortcuts.ts";
import type { AgentMessage, ImageBlock } from "../../lib/types.ts";
import { Composer } from "./Composer.tsx";
import { PermissionDeniedCard } from "./PermissionCard.tsx";
import { PermissionRequestCard } from "./PermissionRequestCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { permissionBanner, type PermissionMode } from "./PermissionModeSwitch.tsx";
import { SessionStats } from "./SessionStats.tsx";
import { MessageList } from "./MessageList.tsx";
import { NewSessionHero } from "./NewSessionHero.tsx";
import { parseBuiltinCommand } from "./slash.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { useComposerState } from "./useComposerState.ts";
import { useConversation } from "./useConversation.ts";
import styles from "./ConversationPane.module.css";

export function ConversationPane() {
  const t = useT();
  const state = useStore(appStore);
  // A draft has no pi process yet, so the conversation runs without a path
  // until the spawn resolves and swaps the real one in.
  const selected = state.selectedSessionPath;
  const draft = isDraftSession(selected);
  const sessionPath = draft ? null : selected;

  const conversation = useConversation(sessionPath);

  /**
   * Is the session this draft is becoming running right now?
   *
   * `useConversation` cannot answer while the path is still `draft:` — it is
   * given `null` and never subscribes. But the app-wide run mark is kept under
   * the path the server is currently using, which for a fresh session is
   * exactly the draft key. Reading it here is what keeps the Stop button on
   * screen for the first turn, before `system:init` swaps the key.
   */
  const draftRunning = draft && selected !== null
    ? state.sessionActivity[selected] === "ongoing"
    : false;

  /**
   * 会话还没落盘时，把「刚发出去的那条消息」画进转录。
   *
   * 新建会话的第一条消息由 `startDraftSession` 直接 POST，而这段窗口里
   * `useConversation` 根本没挂载（没有路径可订阅），也没有磁盘转录可读 ——
   * 不留这一条，用户看到的就是自己打出去的字凭空消失，一直要到回复结束、
   * 会话落到 jsonl 上才重新出现。会话拿到真实路径后 `renameSessionPath` 会清掉它，
   * 之后以磁盘那份为准，不会画两遍。
   */
  const draftMessage = state.draftFirstMessage;
  const optimisticView = useMemo(() => {
    if (!draft || draftMessage === null || draftMessage.sessionPath !== selected) return conversation;
    const message: AgentMessage = {
      role: "user",
      content:
        draftMessage.images.length === 0
          ? draftMessage.text
          : [{ type: "text", text: draftMessage.text }, ...draftMessage.images],
      timestamp: draftMessage.at,
    };
    return {
      ...conversation,
      messages: [message, ...conversation.messages],
      // 这条消息已经交给服务端了，但它还没有开启任何一轮 —— 让分组把它算进
      // 「尚未被接走」的那一侧，免得转录在回复到达前就显示出一个空轮次。
      undeliveredPrompts: conversation.undeliveredPrompts + 1,
    };
  }, [conversation, draft, draftMessage, selected]);

  useEffect(() => {
    if (!draft || !selected) return;
    let cancelled = false;
    void api
      .getState(selected)
      .then((res) => {
        if (cancelled) return;
        if (res?.sessionPath && res.sessionPath !== selected && !isDraftSession(res.sessionPath)) {
          actions.renameSessionPath(selected, res.sessionPath);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draft, selected]);
  // The right sidebar's state is per session, so the header's toggle reads the
  // same surface the panel itself does. It is drawn only while the panel is
  // hidden — when it is open, the panel's own strip carries the collapse
  // control, and a second one would be a second way to say the same thing.
  const rightbarState = useStore(rightbarStore);
  const rightbarOpen = rightbarState.surfaces[selected ?? ""]?.open === true;
  // The model picker and context ring describe the session the text goes into.
  // They read from the session file until a pi process is needed, which is only
  // when the user actually opens one of them — see `useComposerState`.
  const composer = useComposerState({ sessionPath, projectId: null });

  /**
   * Hand each turn's changed files to the review tabs.
   *
   * The sidebar has no way to reach the transcript, so the pane that holds it
   * publishes. The session is bound here rather than on every call site, and the
   * callback is stable so `MessageList`'s effect does not refire on each render.
   */
  const publishChanges = useCallback(
    (changes: readonly TurnChanges[]) => {
      if (sessionPath !== null) publishTurnChanges(sessionPath, changes);
    },
    [sessionPath],
  );

  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId);
  const sessions = state.selectedProjectId ? (state.sessions[state.selectedProjectId] ?? []) : [];
  const session = sessions.find((candidate) => candidate.path === selected);

  /**
   * 权限模式。**会话级状态**，权威值在服务端句柄上（`system:init.permissionMode`）。
   *
   * 这里保留一份本地值是为了**点击立刻生效**，但每次会话切换都要重新对齐 ——
   * 否则从「跳过全部检查」的会话切到别的会话，横幅会跟着跑过去，而那个会话
   * 其实还是默认模式。`null` 只表示「还没读到」，此时按钮显示「未知模式」。
   */
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);

  useEffect(() => {
    // 会话换了就把上一份清掉，避免把一个会话的模式显示成另一个会话的。
    setPermissionMode(null);
    if (sessionPath === null) return;
    let cancelled = false;
    void api
      .getState(sessionPath)
      .then((res) => {
        if (cancelled) return;
        const mode = res?.state?.permissionMode;
        if (typeof mode === "string") setPermissionMode(mode as PermissionMode);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionPath]);

  const changePermissionMode = useCallback(
    async (mode: PermissionMode): Promise<void> => {
      const target = sessionPath ?? (draft ? await actions.resolveDraftSession() : null);
      if (!target) return;
      // 先改本地：切换是用户点击的直接后果，不该等一个网络往返才动。
      const previous = permissionMode;
      setPermissionMode(mode);
      try {
        await api.setPermissionMode(target, mode);
      } catch (err) {
        // 失败就退回去 —— 显示一个「你以为切了其实没切」的模式是最坏的结果。
        setPermissionMode(previous);
        actions.setNotice(`切换权限模式失败：${(err as Error).message}`);
      }
    },
    [sessionPath, draft, permissionMode],
  );
  const banner = permissionBanner(permissionMode);
  const isExternal = selected ? Boolean(state.externalChanged[selected]) : false;
  const commands = state.selectedProjectId ? (state.commands[state.selectedProjectId] ?? []) : [];

  /**
   * A message typed before the spawn finished is queued for the real session
   * and delivered by the conversation instance that mounts for it.
   */
  const sendMessage = useCallback(
    async (text: string, mode: "prompt" | "steer" | "followUp", images: ImageBlock[] = []): Promise<boolean> => {
      // A built-in command is not a message. It maps to its own RPC method, so
      // it runs here and never reaches the model.
      const builtin = parseBuiltinCommand(text, commands);
      if (builtin) {
        const target = sessionPath ?? (draft ? await actions.resolveDraftSession() : null);
        if (!target) return false;
        try {
          const result = await api.runBuiltinCommand(target, builtin.command.name, builtin.args);
          actions.setNotice(result.message);
        } catch (err) {
          actions.setNotice(`/${builtin.command.name}：${(err as Error).message}`);
        }
        // Compaction and renames change what the transcript reports.
        await conversation.reload();
        return true;
      }

      if (sessionPath) return conversation.send(text, mode, images);
      if (!draft) return false;
      const realPath = await actions.resolveDraftSession();
      if (!realPath) return false;
      try {
        const res = await api.prompt(realPath, text, images);
        if (res?.sessionPath && res.sessionPath !== realPath && !isDraftSession(res.sessionPath)) {
          actions.renameSessionPath(realPath, res.sessionPath);
        }
        return true;
      } catch (err) {
        actions.setNotice((err as Error).message);
        return false;
      }
    },
    [sessionPath, draft, conversation, commands],
  );

  /**
   * Stop the current turn.
   *
   * `conversation.abort()` needs a real session path, and a draft has none —
   * `useConversation` is handed `null` until the spawn resolves. So while the
   * first message is still waiting on that spawn (or the CLI is already
   * retrying under a draft key), pressing Stop used to return silently: no
   * request at all, and no way to call the turn off. Resolving the draft first
   * gives it something to stop once the session exists, which is exactly the
   * process that was spawned for it.
   */
  const abortTurn = useCallback(async (): Promise<void> => {
    if (sessionPath) {
      await conversation.abort();
      return;
    }
    if (!draft) return;
    const target = await actions.resolveDraftSession();
    if (!target) return;
    try {
      await api.abort(target);
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  }, [sessionPath, draft, conversation]);

  const reload = async (): Promise<void> => {
    await conversation.reload();
    if (sessionPath) actions.clearExternalChanged(sessionPath);
  };

  /**
   * Fork at a user message.
   *
   * pi does not copy the session — it moves the session's leaf pointer back to
   * that entry, so the turns after it leave the visible transcript. They are not
   * lost (they stay in the file as a sibling branch, reachable through the
   * entry tree), but a user who forks and sees the rest of the conversation
   * vanish deserves to be told where it went rather than left to wonder.
   */
  const onFork = (entryId: string): void => {
    void conversation
      .fork(entryId)
      .then((result) => {
        // null means an extension vetoed the fork, which is its own answer.
        if (result === null) return;
        const label = result.text.replace(/\s+/g, " ").trim().slice(0, 30);
        // Follow the new branch: it is a separate session, so the app has to
        // switch to it and pick it up in the sidebar.
        actions.selectSession(result.sessionPath);
        void actions.refreshProjects().then(() => {
          // Reveal the project so the new session row is actually visible when
          // the sidebar re-renders.
          if (project !== undefined) actions.expandProject(project.id);
        });
        actions.setNotice(t("pane.forkedNotice", { label }));
      })
      .catch((err: Error) => actions.setNotice(err.message));
  };

  // A waiting dialog is a hard block on its pi process, so it takes the
  // composer's seat rather than floating over the page: the answer goes where
  // the next message would have been typed. The open session's own request
  // wins the seat; a request from another session still appears, because that
  // process is just as blocked, and carries a jump line instead.
  const pendingUi =
    state.pendingUiRequests.find((item) => item.sessionPath === sessionPath) ??
    state.pendingUiRequests[0] ??
    null;
  const pendingSession =
    pendingUi && pendingUi.sessionPath !== sessionPath
      ? Object.values(state.sessions)
          .flat()
          .find((candidate) => candidate.path === pendingUi.sessionPath)
      : undefined;
  const questionCard = pendingUi ? (
    <QuestionCard
      // The request id is the card's identity, and only that: a draft session
      // swaps its provisional path for the real one a second after the spawn
      // resolves, and keying on the session path would remount the card and
      // throw away the row the user had already picked.
      key={pendingUi.request.id}
      pending={pendingUi}
      sessionLabel={pendingSession?.title}
      onOpenSession={
        pendingSession ? () => actions.selectSession(pendingUi.sessionPath) : undefined
      }
    />
  ) : null;

  // Nothing open: show the new-session hero instead of a header + empty list.
  if (!sessionPath && !draft) {
    return (
      <div className={styles.pane}>
        {/* macOS only (the rule hides it elsewhere): with no Session there is no
            header, so this empty row keeps the center column's window-drag band
            over the hero. */}
        <header className={styles.headerBlank} data-window-drag aria-hidden />
        <NewSessionHero />
        {questionCard}
      </div>
    );
  }

  const headerSub = draft
    ? t("pane.preparing")
    : sessionPath
      ? (session?.title ?? t("pane.session"))
      : t("pane.noSession");

  return (
    <div className={styles.pane}>
      <header className={styles.header} data-window-drag>
        <span className={styles.headerTitle}>{project?.title ?? "anhe-claude-web"}</span>
        <span className={styles.headerSub}>{headerSub}</span>
        {draft ? <span className={styles.spinner} aria-hidden /> : null}
        {sessionPath !== null && !draft && !rightbarOpen ? (
          <button
            type="button"
            className={styles.headerPanelAction}
            title={shortcutTitle(t, t("pane.openRightbar"), "rightbar.toggle")}
            aria-label={t("pane.openRightbar")}
            onClick={() => rightbarActions.open(sessionPath)}
          >
            <PanelRightIcon width={14} height={14} />
          </button>
        ) : null}
      </header>

      {/*
       * 放宽权限的常驻提示。`bypassPermissions` 下所有工具都不再问你，这件事
       * 不能只写在那个小小的模式按钮上 —— 它必须一直在视野里，直到主人改回去。
       */}
      {banner !== null ? (
        <div
          className={clsx(
            styles.modeBanner,
            banner.level === "danger" ? styles.modeBannerDanger : styles.modeBannerWarn,
          )}
          role="status"
        >
          <span className={styles.bannerIcon}>
            <AlertIcon />
          </span>
          <span className={styles.modeBannerText}>{banner.text}</span>
        </div>
      ) : null}

      {isExternal ? (
        <div className={styles.banner} role="status">
          <span className={styles.bannerIcon}>
            <AlertIcon />
          </span>
          <span className={styles.bannerText}>{t("pane.stale")}</span>
          <button type="button" className={styles.bannerAction} onClick={() => void reload()}>
            <RefreshIcon />{t("pane.reload")}</button>
        </div>
      ) : null}

      {conversation.error ? (
        <div className={styles.errorBanner} role="alert">
          {conversation.error}
        </div>
      ) : null}

      <MessageList
        view={optimisticView}
        cwd={project?.path}
        home={state.home}
        transcriptView={state.settings.transcriptDisplay}
        onFork={onFork}
        {...(sessionPath === null
          ? {}
          : {
              // A turn's changed files open that turn's review in the sidebar —
              // dsh's review tab, where the comparison, the other files of the
              // turn and the way into the whole file all live. The panel opens
              // itself if it was collapsed, so the click always lands somewhere
              // visible.
              onOpenChanges: (turn: number, index: number) =>
                rightbarActions.openTurnChangesTab(sessionPath, turn, index),
              onOpenFile: (path: string) =>
                rightbarActions.openPreviewTab(sessionPath, path),
              onTurnChanges: publishChanges,
              // pi has no "try that turn again" RPC — its own retry loop is the
              // only one it offers, and it runs inside a turn. Re-sending the
              // prompt is the lever that exists, and it costs a second copy of
              // the user's message because that is genuinely what is sent. A
              // second `prompt` while pi is running is rejected outright, so a
              // busy session takes the retry as a queued follow-up instead —
              // the same choice the composer makes, minus the setting.
              onRetry: (text: string, images: ImageBlock[]) =>
                void conversation.send(text, conversation.isStreaming ? "followUp" : "prompt", images),
            })}
      />
      {/* Between transcript and composer, where dsh puts its plan strip: the
          list belongs to the input it is about to steer, not to the history. */}
      <TodoPanel todos={conversation.todos} />
      {/* One seat, two occupants: a pending question replaces the input rather
          than stacking above it, so the card cannot be confused for a message
          that has already been sent. */}
      {/* 被 CLI 拒绝的工具：如实展示原因。本项目不能替用户批准，只能把话说清楚。 */}
      {conversation.denials.length > 0 ? (
        <div className={styles.denials}>
          {conversation.denials.map((denial, index) => (
            <PermissionDeniedCard
              key={`${denial.toolUseId ?? "denial"}-${denial.at}-${index}`}
              toolName={denial.toolName}
              message={denial.message}
              decisionReasonType={denial.decisionReasonType}
            />
          ))}
        </div>
      ) : null}
      {/*
       * 权限提问卡占的是同一个「座位」：CLI 那一轮正卡在它身上，让它和输入框
       * 并存只会让人以为消息还能照发。多个提问同时挂起时按到达顺序排开。
       */}
      {conversation.permissionRequests.length > 0 ? (
        <div className={styles.denials}>
          {conversation.permissionRequests.map((request) => (
            <PermissionRequestCard
              key={request.requestId}
              request={request}
              onAnswer={(requestId, classification) =>
                conversation.answerPermission(requestId, classification)
              }
            />
          ))}
        </div>
      ) : null}
      {questionCard ?? (
        <Composer
          /*
           * 草稿期也要显示「停止」。`useConversation` 在 draft 阶段拿到的是 null
           * 路径，它自己的 `isStreaming` 永远是 false；可服务端那一轮已经开跑了
           * （`agent_start` 是按 draft 键下发的，app state 把它记成了 "ongoing"）。
           * 不并上这个标记，首条消息发出后到 `system:init` 改名之间，输入框右侧
           * 只有「发送」没有「停止」。
           */
          isStreaming={conversation.isStreaming || draftRunning}
          disabled={conversation.loading}
          commands={commands}
          busySendBehavior={state.settings.busySendBehavior}
          session={
            sessionPath === null
              ? undefined
              : {
                  model: composer.state?.model ?? null,
                  models: composer.state?.models ?? null,
                  thinkingLevel: composer.state?.thinkingLevel ?? "auto",
                  context: composer.state?.context ?? null,
                  loading: composer.modelsLoading,
                  onRequestLive: () => void composer.ensureLive(),
                  onSelectModel: (provider, id) => void composer.selectModel(provider, id),
                  onChangeThinkingLevel: (level) => void composer.selectThinkingLevel(level),
                  permissionMode,
                  onChangePermissionMode: (mode) => {
                    void changePermissionMode(mode);
                  },
                }
          }
          onSend={sendMessage}
          onAbort={() => void abortTurn()}
          workspacePath={project?.path}
        />
      )}
      {/* Under the composer, where dsh puts its two stat pills: they describe
          the session the input is being typed into, not the transcript above. */}
      <SessionStats stats={conversation.stats} />
    </div>
  );
}
