# 设计说明

本项目的界面、会话模型与右栏 IDE **来自
[pi-web-simple](https://github.com/woxihejinghao/pi-web) 的直接移植**，
而 pi-web-simple 的界面又是
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) Web UI 的移植。
排版层级、尺寸度量、动效、设计 token 与文案大量照搬，署名见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

因此：**上游那份 609 行的 `design-notes.md` 依然是本项目视觉与交互设计的权威文档**，
只是把文中「pi」读作「Claude Code CLI」。本文件只记录**本项目改动了什么、为什么改**，
不复述上游的设计理由。

## 一、整体形态

一句话：**一个目录就是一个项目，一个 jsonl 就是一个会话。** 三栏。

- 左栏：项目树 → 会话列表
- 中栏：对话（流式输出、工具调用、权限卡、输入框）
- 右栏：IDE（文件树、Git 变更、终端、预览）

服务端是一个 Node 进程，同时托管构建好的前端和 API，用 SSE 单向推送事件。
这些结构**一条都没改**。

## 二、换掉的：驱动层

pi-web 通过 `@earendil-works/pi-coding-agent` 的 `RpcClient` 起 `pi --mode rpc`。
本项目换成**直接 spawn 本机已安装的 `claude`**，走它的公开命令行协议：

```
claude -p
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --verbose
```

- `-p`（非交互）+ 双向 JSONL，stdin 喂用户消息、stdout 出事件——这与 `RpcClient`
  的通信模型形状一致，所以 `registry.ts` 的骨架（每会话一进程、空闲回收、最大并发、
  单写者、预热）能原样保留，只换掉里面 spawn 什么、怎么写、怎么读。
- **不用官方 SDK**（`@anthropic-ai/claude-agent-sdk`）。理由：它会多一个需要版本对齐的
  依赖，而它封装的东西（权限回调用 `can_use_tool`、控制消息）我们已经通过实测把
  精确 schema 拿到了。协议事实记录在 `../PROJECT_RULES.md`。
- **不打包、不下载 Claude Code。** `locate.ts` 只负责找用户已经装好的那个。

## 三、协议隔离：两个文件的规矩

这是本项目最重要的一条代码组织约定：

> **协议细节只允许出现在 `server/src/agent/normalize.ts` 与 `server/src/agent/controls.ts`。**

理由：Claude Code 的 jsonl 与事件格式是**私有实现细节**，随时可能变。
把协议知识摊进路由、存储、前端，等于让一次升级变成全仓库改动。

- `normalize.ts`：把 `stream_event` / `assistant` / `result` 归一成前端已经消费的
  `message_update` 形状。归一是**降级安全**的——上游不给增量就退化成整条一次性更新。
- `controls.ts`：`control_request` / `control_response` 的编解码。只有它知道
  `can_use_tool` 的字段、`updatedPermissions` 的六种 `type`、六种 `permissionMode`。

其余所有代码（`routes.ts`、`sessions.ts`、前端全部）**与协议无关**。

## 四、前端最大的新增：权限与拒绝

pi-web 没有这个界面——因为 pi 的权限模型不同。Claude Code 每次要跑工具都会**阻塞**，
等宿主回一个决定。本项目把这条路接上了，靠的是一个内置的 MCP 中继。

### 4.1 「允许 / 拒绝」按钮是怎么接通的

设计之初只试了两条死路：`--permission-prompts host` 拿不到提问（只会收到
`system:permission_denied`），`--sdk-url` 被
`host "127.0.0.1" is not an approved Anthropic endpoint` 直接拒。
**第三条路是 `--permission-prompt-tool`**：给出 `mcp__<服务器>__<工具>` 形式的工具名，
CLI 需要授权时会**调用那个 MCP 工具**，把返回的 JSON 文本当裁决。

于是实现是：

```
CLI ──tools/call──▶ POST /api/mcp/permission?relay=<uuid>   （本进程，loopback）
                              │
                              ▼
                     registry.askByRelay()
                              │  下发 permission_request（SSE）
                              ▼
                     PermissionRequestCard（三个按钮）
                              │  用户点击
                              ▼
                     POST /api/sessions/:id/permissions/:requestId
                              │  answerPermission()
                              ▼
                     tools/call 的结果 ──▶ CLI 继续或停下
```

`server/src/permission-relay.ts` 只负责 MCP/JSON-RPC 的信封；裁决体
（`behavior` / `updatedPermissions` / `decisionClassification`）仍然由
`agent/controls.ts` 构造，协议知识没有被复制一份。

**`PermissionDeniedCard` 并没有被取代**：它是「已经拒绝」的说明，仍有它的位置
（CLI 按规则直接拒、或用户点了拒绝之后）。两者关系见 4.3。

本界面能做的四件事：

1. **弹卡让用户决定**（`PermissionRequestCard`：允许一次 / 总是允许 / 拒绝）
2. **切换模式**（六态，见 4.2）
3. **如实展示拒绝**（`PermissionDeniedCard`，见 4.3）
4. **用户显式点击后才写 allow 规则**（不主动替你放宽权限）

### 4.2 `PermissionModeSwitch`：六态

`default` / `acceptEdits` / `plan` / `dontAsk` / `auto` / `bypassPermissions`，
与 `controls.ts` 的 `PERMISSION_MODES` 一一对应。

- `plan` 模式顶部挂横幅（它在计划，不会动手）。
- `bypassPermissions` 切换要二次确认，开启期间常驻警告条。
- **切换是会话级动作**，只影响当前会话的进程；新建会话永远从 `default` 开始。

### 4.3 `PermissionDeniedCard`：它不是什么

文件名是 `PermissionCard.tsx`，但导出的组件叫 **`PermissionDeniedCard`**——
这个名字改得刻意，因为**它不是一个「允许 / 拒绝」按钮**。

它是一条**如实的拒绝说明**：CLI 拦下了某个工具，我们把原始原因
（`message`、`decision_reason_type`）**完整摆出来、不截断、不改写**，
并告诉用户三条可走的路。

含糊其辞（「操作已取消」）会让人以为程序坏了；把原因摊开，用户才知道
要么去终端批、要么换模式、要么改命令。

### 4.4 `tool-map.ts`

Claude Code 的工具名 → 展示组件。`Bash` 渲染成命令块、
`Read/Edit/Write` 渲染成路径 + diff、`Grep/Glob` 渲染 pattern、`Task` 折叠成子代理块、
`TodoWrite` 喂 `TodoPanel`、`AskUserQuestion` 复用 `QuestionCard`、
`ExitPlanMode` 走计划审批卡。
## 五、会话来源：从「pi 的 session dir」改成「`~/.claude/projects`」

- 项目分组**只读 jsonl 每行的 `cwd`**。Claude Code 的目录 slug 不可反推
  （实测 `E--code-Oracle` 与真实路径对不上），任何基于 slug 的解码都会错。
- 标题三级：`summary` 行 → 首条 user 文本截断 → LLM 兜底（沿用 `title-service`）。
- `isSidechain: true` 的条目归到父会话的「子代理」分组，不单独成会话。
- **jsonl 只读。** 写入一律由 CLI 进程负责。绕过 CLI 去写等于在一个没有契约的格式上
  做双写，迟早写坏用户的会话历史。

## 六、模型：全部动态读

- `system:init.model` = 当前生效模型
- `~/.claude/settings.json` 的 `modelPicker.options[].{model,label,description}` = 候选
- `modelSettings.<model>.effortLevel` = 推理强度

**不硬编码任何模型名。** 上游改名字、用户改配置，UI 跟着变。

## 七、上游可能是坏的

实测过一种情况：`settings.json` 把 `ANTHROPIC_BASE_URL` 指向一个不兼容的代理，
所有请求 400。用户环境里会有同类问题（key 过期、地址填错、代理挂了）。

所以加了 `/api/health/upstream`：一次最小探针，首屏显示可操作的提示，
而不是让用户在聊天框里看到一个裸的 400。

## 八、没做的

`./known-limitations.md` 有一份完整清单。三条最值得先知道：

1. **没有 Electron 版。** 只有网页。
2. **进程模型不常驻。** 空闲 10 分钟回收，再发消息用 `--resume` 重开，约 1–2 秒。
3. **打字机效果取决于上游是否转发 SSE 增量。** 不转发就整段出现，内容没错。

## 九、运行机制：一个会话一个进程

这是理解本项目行为的核心，也是所有「为什么慢」「为什么刷新后要等」的答案来源。

### 8.1 进程生命周期

```
POST /api/sessions            → 返回 draft:<项目路径>（还没有 jsonl）
POST /api/sessions/:id/prompt → 起 claude 子进程，写第一条 user 消息
                              → CLI 发 system:init，带回 session_id
                              → 服务端广播 session_renamed{draft:… → <id>.jsonl}
空闲 ANHE_CLAUDE_WEB_IDLE_MS   → 回收子进程（默认 10 分钟）
再次发消息                     → --resume <id> 重开，约 1–2 秒
```

三个由此而来的事实：

- **新会话在第一条消息发出前没有 id。** 路径是 `draft:<项目路径>` 这个临时键。
  此时刷新页面会回到「新会话」状态——这不是丢数据，是 CLI 还没给 id。
- **`session_renamed` 必须送到订阅旧键的流上。** 否则订阅方永远停在 `draft:` 键上，
  之后一条事件都收不到。实现在 `bus.ts` 的 `wantsFrame`。
- **`--resume` 是有代价的。** 比不了终端里的常驻进程，但换来的是空闲时不占内存。

### 8.2 并发与回收

- 最多同时 `ANHE_CLAUDE_WEB_MAX_SESSIONS`（默认 8）个子进程。
- 超了先回收最久未用的那个（`evictOldest`）。
- 会话文件全部落盘在 `~/.claude/projects/`，进程没了历史还在。

### 8.3 fork 的真实行为

`--resume <id> --fork-session` 在 Claude Code 上是**开一个新文件**，
不是 pi 那种「把当前会话的 leaf 挪回去」。三个实测事实：

1. 单独启动**不发** `system:init`，要等第一条 prompt。
2. init 后立刻 `interrupt` **不会落盘**新 jsonl，要真跑完一轮。
3. fork 文件的**项目目录跟随 `cwd`**，所以 fork 必须用原会话的 `projectPath` 启动。

后果：新会话的第一条会是我们发的一句占位消息（`FORK_OPENER`）。
「只复制历史、不说话」在这个 CLI 上做不到。详见 `known-limitations.md`。

## 十、事件流：SSE 单向推送

服务端只推不拉。浏览器开一条 `GET /api/events`，服务端按会话路径过滤后推送。

事件类型（前端 `useConversation.ts` 消费的）：

| 类型 | 含义 |
|---|---|
| `session_init` | CLI 报告会话已建立，带 `session_id`、`model`、`tools`、`permissionMode` |
| `session_renamed` | draft 键迁移到真实 jsonl 路径 |
| `message_start` / `message_update` / `message_end` | 一条助手消息从开始到结束 |
| `text_delta` / `thinking_delta` | 逐字增量（打字机效果靠它） |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 工具调用的流式参数 |
| `tool_execution_start` / `_update` / `_end` | 工具真正执行的过程 |
| `permission_denied` | 权限被 CLI 拦下（**不是**询问，是已拒绝） |
| `turn_result` | 一轮结束，带 `total_cost_usd`、`usage`、`duration_ms` |
| `agent_settled` | 整个 agent 停下来了（验收脚本等这个） |

**归一是降级安全的**：上游不给增量，`normalize.ts` 就退化成整条一次性更新，
内容不会错，只是没有动效。

### 握手帧 `hello` 与「刷新后还能停」

SSE 连接建立时服务端先发一帧 `hello`：

```jsonc
{
  "connectionId": "…",
  "activeSessions": ["<有活进程的会话路径>"],
  "runningSessions": ["<其中正在跑一轮的会话路径>"]
}
```

两者缺一不可。`activeSessions` 只管进程是否存在（空闲驻留也算），而**运行标记
只活在浏览器内存里** —— 刷新、开新标签、或在另一个标签里打开别人开的会话，都以
一份空标记起步。没有 `runningSessions`，卡在退避重试里的回合在刷新后既没有「停止」
按钮，也不会再收到 `agent_start`（它早已发过），于是只能干等 CLI 放弃。
前端把它并进 `sessionActivity`，恢复成 `"ongoing"`。

另外两处容易漏的：**draft 阶段**（还没有 jsonl、`useConversation` 拿到 null 路径）
的停止按钮靠 `sessionActivity[draftKey]` 点亮，并先 `resolveDraftSession()` 再发
abort；**abort 的 3 秒安全超时**只允许清理「它自己那一轮」，否则会把用户紧接着
发起的下一轮误标成已停止，症状同样是停止按钮消失。

## 十一、API 地图

给要改代码的人一张索引。全部挂在同一个端口，前端与 API 同源。

### 元信息与健康

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活与活动会话数 |
| GET | `/api/health/upstream` | 上游是否可用（最小探针） |
| GET | `/api/meta/cli` | 找到的 Claude Code 路径、版本、来源 |
| GET | `/api/meta/models` | 模型候选（动态读，不硬编码） |
| GET | `/api/env` | 环境快照（不含密钥） |

### 项目与会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects` | 项目列表 / 注册项目 |
| PATCH/DELETE | `/api/projects/:id` | 改名 / 移除 |
| GET | `/api/projects/:id/sessions` | 该项目下的会话（按 jsonl 的 `cwd` 分） |
| POST | `/api/sessions` | 新建，返回 `draft:<项目路径>` |
| GET | `/api/sessions/:id/messages` | 消息列表 + `forkPoints` |
| POST | `/api/sessions/:id/prompt` | 发消息（字段名是 **`message`**，不是 `text`） |
| POST | `/api/sessions/:id/abort` | 中断当前轮次（幂等） |
| POST | `/api/sessions/:id/fork` | 从某个 `entryId` 分叉，返回**新**会话路径 |
| POST | `/api/sessions/:id/rename` | 改标题 |
| POST | `/api/sessions/:id/reload` | 重新从磁盘读 |

### 权限与用量

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions/:id/permissions` | 待处理的权限请求（第一版恒为空） |
| POST | `/api/sessions/:id/permission-mode` | 六态切换 |
| POST | `/api/sessions/:id/permissions/:requestId` | 回答权限请求（协议放开后才用得上） |
| GET | `/api/sessions/:id/usage` | token 与花费 |

### 右栏 IDE

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/fs/list`、`/api/fs/locations` | 目录浏览 |
| GET | `/api/projects/:id/files`、`/file`、`/text`、`/raw` | 文件树与文件内容 |
| GET | `/api/projects/:id/git` | Git 变更 |
| POST | `/api/projects/:id/git/{stage,commit,discard,push,branch}` | Git 操作 |
| GET/POST/DELETE | `/api/terminal` | 终端（需要可选依赖 `node-pty`） |

### 只读边界

模型 provider、MCP、扩展的**写**路由统一返回 400 / 404。想改就去改
`~/.claude/settings.json`，或者用终端里的 `/config`、`/mcp`。
理由：这些文件没有公开 schema 契约，用 UI 写进去等于在别人的私有格式上做双写。

## 十二、端口

| 场景 | 端口 |
|---|---|
| 发布版（`npx anhe-claude-web`） | **5419** |
| 开发：后端 | 4419（`server/src/config.ts` 的默认值） |
| 开发：前端 Vite | 5519 |
| pi-web-simple（若同机共存） | 5319 |

注意 `config.ts` 里写的默认是 4419（开发用），发布版由 `cli/bin.js` 显式传 5419
（它会在启动服务前设 `process.env.ANHE_CLAUDE_WEB_PORT`）。
这两个数字**不一样是故意的**：开发时不该抢发布版的端口，否则本地装过全局包的人
一跑 `pnpm dev` 就会撞上已在运行的发布版。

`pnpm dev` 走的是三个端口：你打开 5519（Vite），它把 `/api` 反代到 4419（后端）。
发布版没有这一层，同一进程同时回答前端与 API。
