# 已知限制

这份清单记录本项目目前**做不到**什么，以及那些行为背后的取舍。装之前值得先扫一遍。

## 与 pi-web 的关系

- 本项目是 [pi-web-simple](https://github.com/woxihejinghao/pi-web) 的移植：界面、会话模型、
  右栏 IDE 几乎原样照搬，**换掉了驱动层的 agent**。所以 pi-web 的设计说明文档
  （`design-notes.md`）里凡是提到「pi」的地方，在本项目里指的是 Claude Code CLI。
- **没有 Electron 桌面版**。只有网页。想要「像应用一样」，用浏览器的「安装此站点为应用」。

## 驱动 Claude Code 的限制

- **不内置模型、不内置密钥、不打包 Claude Code。** 你必须自己装好
  `@anthropic-ai/claude-code` 并配置好上游，否则首屏就会提示找不到 CLI 或上游不可用。
- **进程模型是「一会话一进程」。** 每个打开的会话会拉起一个
  `claude -p --input-format stream-json --output-format stream-json` 子进程。
  空闲超过 `ANHE_CLAUDE_WEB_IDLE_MS`（默认 10 分钟）会被回收，再次发消息时用 `--resume` 重开。
  重开是**有代价**的（约 1–2 秒），比不了终端里的常驻进程。
- **会话 id 不是我们选的。** 实测 `--session-id` 参数不生效，所以新会话的 id 一律以 CLI
  回报的 `system:init.session_id` 为准。有一个可见后果：新会话在第一轮 `init` 到达之前
  还没有 id，这时刷新页面会回到「新会话」状态。
- **打字机效果取决于上游。** 增量靠 `stream_event`（需要 `--include-partial-messages`）。
  如果上游是那种不转发 SSE 增量的中转代理，你会看到**整段一次性出现**而不是逐字——
  内容是对的，只是没有动效。这不是本项目的 bug。
- **不采用官方 SDK。** `@anthropic-ai/claude-agent-sdk` 能用，但会给发布包多加一个
  需要版本对齐的依赖，而它封装的东西（`canUseTool`、控制消息）我们已经直接用裸协议
  精确掌握了。这条选择记在 `../PROJECT_RULES.md`。

## 权限与安全

- **默认只绑 `127.0.0.1`，没有认证。** 不要反代到公网，见 [SECURITY.md](../SECURITY.md)。
- **权限确认卡能弹，走的是内置 MCP 中继。** CLI 需要授权时会调用
  `--permission-prompt-tool` 指向的 MCP 工具，本项目用它自己的
  `POST /api/mcp/permission` 回答（见 `PROJECT_RULES.md` 5.5）。卡片是
  **`PermissionRequestCard`**：显示工具名与**原样的完整入参**，三个按钮
  「允许一次 / 总是允许 / 拒绝」。
  - 「总是允许」会把规则写进 `~/.claude/settings.json` 的 `permissions.allow`，
    与终端里 `/permissions` 一致，**只由你显式点击触发**。
  - 中继的配置文件落在系统临时目录，随会话回收删除；URL 里带一次性 relay id，
    不写进任何日志。
  - 如果 CLI 因为规则直接拒了（不经过中继），界面仍然显示
    **`PermissionDeniedCard`** —— 那是一张事后的拒绝说明，没有按钮。
- **权限模式六态**：`default`（默认，危险操作弹窗）、`acceptEdits`、`plan`、`dontAsk`、
  `auto`、`bypassPermissions`。
  - `bypassPermissions` 会让**所有**工具调用不经确认直接执行。切换时二次确认，
    开启期间页面顶部常驻警告条。本项目永不替你打开它。
  - `dontAsk` 不弹窗，未预授权的调用**直接拒绝**——它比 `default` 更严格，不是更松。
- **permissionMode 是会话级状态，不是全局设置。** 切换只影响当前会话的进程。
  新建会话默认从 `default` 开始；新建页（`NewSessionHero`）里可以先选好模式，
  它会随 `POST /api/sessions` 一起下发给子进程，不用等会话开出来再改。
- **「总是允许」的粒度由 Claude Code 决定。** 它给的 `permission_suggestions` 可能是
  「允许这一条命令」也可能是「允许这个工具」，UI 如实展示它建议的内容，不自己发明粒度。
- **终端面板能执行任意命令**，它没有额外的权限确认——那是终端该有的样子。
  但它同样只在本机可及。

## 会话与历史

- **`~/.claude/projects/*/*.jsonl` 只读。** 本项目不修改、不追加、不删除这些文件。
  删除会话走 CLI 或本项目的自有元数据。
- **项目分组用 jsonl 行内的 `cwd`，不用目录名。** Claude Code 的 slug 编码不可反推
  （实测 `E--code-Oracle` 与真实路径对不上），任何基于 slug 的路径解码都会错。
- **子代理（`isSidechain: true`）的条目归到父会话下的「子代理」分组**，不单独成会话。
- **标题来源三级**：`summary` 行 → 首条 user 文本截断 → LLM 兜底（沿用 pi-web 的
  `title-service`，需要一个可用的上游）。
- **fork 之后新旧会话共享历史前缀**，各自独立往后写。原会话一条都不丢。
- **fork 会在新会话里多出一条占位消息。** Claude Code 的 `--fork-session` 只在
  新会话跑完一轮之后才把 jsonl 写出来，而 `system:init` 也要等第一条 prompt。
  所以「只复制历史、不说任何话」在这个 CLI 上做不到，新会话的第一条会是我们发的一句
  「（这是从已有会话分叉出来的新会话，请忽略这条消息。）」。这是协议限制，不是选择。
- **jsonl 的格式是 Claude Code 的私有实现细节**，升级可能变。变了之后本项目读不出来的
  行会被跳过并在日志里记一条，不会崩掉整个会话列表——但可能显示不全。

## 设置页

- **第一版：模型 / MCP / 技能 / 插件四节都是只读展示。** 要改就去改
  `~/.claude/settings.json` 或 `~/.claude.json`，或者用终端里的 `/config`、`/mcp`。
  理由：这些文件的 schema 没有公开契约，用 UI 写进去等于在别人的私有格式上做双写。
- **模型列表全部动态读**：`system:init.model` ∪ `~/.claude/settings.json` 的
  `modelPicker.options`。没写进 settings 的模型不会凭空出现。
- **上下文环的数字来自 Claude Code 的 `usage` 字段**，每轮结束后刷新，不逐 token 更新。
  上游不返回 usage 时显示「未知」，不猜。

## 沿用 pi-web 的、仍然成立的限制

以下条目与上游一致，简单列出，详细理由见 pi-web-simple 的 `design-notes.md`：

- 目录选择器浏览的是**服务端所在机器**的文件系统（即本机）。
- **拖文件夹进输入框只在 Electron 桌面版可用**；本项目没有桌面版，所以网页版会提示
  而不是静默无视。用「引用目录」按钮代替。
- **PDF 预览用浏览器自带的查看器**，样式不跟主题走；>64 MB 拒绝。
- **HTML 预览永不执行脚本**，`sandbox=""` + CSP，没有开关。
- **超长文本手动翻页**（一页 2000 行 / 256 KB），没有「一次读完」。
- 右侧栏**最多左右两格**，没有上下分屏，没有第三格。标签可拖出成浮窗。
- **终端需要可选的 `node-pty`**（原生模块）。装不上时「终端」标签置灰并写明原因，
  其余功能不受影响。一次最多 8 个终端，关标签即杀 shell。
- **快捷键固定不可改**，绑定写在 `features/rightbar/shortcuts.ts`。
- 变更面板**不做提交详情、任意 revision 对比、建分支/合并/rebase、并排 diff**。
- 「本轮改动」面板的数据只活在当前页面，刷新后要等会话重新载入。
- **每轮末尾的改动文件卡片**改用 Claude Code 的工具调用推导（`Write` / `Edit` / `MultiEdit`），
  `Bash` 改的文件同样不在卡里。
- **fork 创建新会话**，不截断当前会话。
- 助手消息下的「赞/踩」没有做：没有地方可写。
- **失败后只能「把这条 prompt 再发一次」，没有真正的重试。**
- **上游报错（如 408 / 5xx）时，Claude Code 自己会退避重试最多 10 次**，
  期间这一轮仍在进行中，界面显示倒计时（`RetryNotice`），「停止」按钮一直可用。
  点停止会走 `interrupt`；实测即使正处在 30 秒以上的长退避里，也在约 0.2 秒内收尾
  （`result.terminal_reason = "aborted_streaming"`）。若进程对 `interrupt` 毫无反应，
  第二次点击或 2.5 秒超时后会升级为 kill 子进程。
- compaction 的可视化还没接（Claude Code 会发 `system:compact_boundary`，第一版忽略）。
- **代码高亮的两个上限**：超过 2 万字符的栅栏在没有可续接前缀时显示为纯文本；
  单行超过 2000 字符的一律不着色（正则引擎在这种行上会真的卡死）。
- **图片以 base64 进会话文件**，上限 8 张/条、5MB/张；只认 `png/jpeg/gif/webp`，`svg` 被拒。

## 分发相关

- **npm 上会看到一个 `0.0.0-stage` 版本。** 这是 npm 的 staged publishing 占位包
  （337 字节的壳），不是正式版本，也不是发错了。`latest` 指向真正的版本，
  `npm i anhe-claude-web` 不会装到它。它删不掉，放着不管就行。详见
  [release.md](./release.md)。
- **包不附带 Claude Code，也不附带任何模型。** `npx anhe-claude-web` 装下来的只有本项目的
  约 860 kB 代码；`claude` 得你自己装，上游得你自己配。
- **本项目没有服务端组件。** 除了「检查更新」时查一次 `registry.npmjs.org` 的版本号，
  运行时不向外发任何请求。见 [network-and-privacy.md](./network-and-privacy.md)。
