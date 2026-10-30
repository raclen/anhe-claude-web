# PROJECT_RULES —— 长期有效的踩坑记录

本文件记录**不容易重新发现**的事实：实测得到的 Claude Code 协议细节、Windows 平台坑、
以及不允许被「顺手改掉」的硬边界。改代码前先读。

实测环境：Windows 11 / Node v22.23.1 / `@anthropic-ai/claude-code@2.1.309`。
探针脚本与完整证据：`E:\code\Oracle\temp\claude-proto\`（FINDINGS.md + out/*.raw.jsonl）。

---

## 一、协议事实（已实测确认，不要凭猜测改）

### 1. Windows 上 `spawn("claude")` 会 ENOENT

`where claude` 返回 `npm\claude`、`claude.cmd`、`claude.ps1` 三个 shim。
Node 22 直接 `spawn("claude")` 报 `ENOENT (errno -4058)`。

真正的可执行文件：
```
%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
```

`locate.ts` 的解析顺序（不要改乱）：
1. `CLAUDE_CODE_PATH` 环境变量
2. 上面的 npm 全局原生 exe
3. `%APPDATA%\npm\claude.exe`
4. PATH 上能找到的 `claude.exe`
5. （POSIX）`claude`
6. 最后才 `shell: true` 走 `.cmd`

### 2. `--session-id` 不生效 —— 会话 id 一律信 `system:init`

实测：传入 `--session-id 2b5be1ae-…`，`system:init` 返回的 `session_id` 是**另一个** uuid，
指定的值被忽略。

**因此新会话流程必须是：** `spawn → 等 system:init → 取 session_id → 才建路由键`。
不要预设 id，也不要拿本地生成的 uuid 当会话 id。

### 3. 项目 slug 不可反推 —— 一律用 jsonl 行内 `cwd`

`system:init.memory_paths.auto` 里的 slug 形如 `E--code-Oracle`，与真实 `cwd`
（`…\temp\claude-proto\work`）**对不上**。任何基于 slug 的路径解码都会错。

**因此项目分组只读 jsonl 每行的 `cwd` 字段。**

### 3b. 项目目录名 slug 的生成规则：每个非字母数字字符各自换成 `-`

**不是把连续的压成一个。** `C:\Users\…` 里 `:` 与 `\` 相邻，所以目录名开头是
`C--Users`；压成一个会得到 `C-Users`，与 CLI 实际写入的目录差一个字符。

差这一个字符的后果不是「显示得不好看」：同一个会话会被当成两个，事件里的路径和磁盘上的
路径对不上，前端整条事件流都跟丢。需要在本地拼占位路径时严格按这个规则。

### 3c. 新建会话必须先 `session_renamed` 才能被订阅到

`POST /api/sessions` 返回 `draft:<token>|<项目路径>`（会话还没有 jsonl）。第一条 prompt
之后 CLI 才发 `system:init` 给出 `session_id`，此时服务端把句柄键改到真实的
`<sessionId>.jsonl` 并广播一条 `session_renamed{previousPath, sessionPath}`。

**这条事件必须送到订阅旧键（`draft:…`）的流上**（见 `bus.ts` 的 `wantsFrame`），
否则订阅方永远停在 draft 键上，之后一条事件都收不到。前端靠它改 `selectedSessionPath`
并重新订阅。

### 3c-1. draft 键必须**每个进程唯一**，不能只用项目路径

**触发信号：** 新建会话后，消息出现在一个几十分钟前的旧会话里；前端却一直停在
「正在准备会话…」，新会话里空无一物。

**根因：** 旧实现把临时键定为 `draft:<项目路径>`，而同一个项目只会有一个这样的键。
第一个会话拿到 `system:init` 后，这个键被写进 `aliases` 表指向那个**已有历史的会话**。
第二次「新建会话」再发出同一个键时，`registry.get()` 顺着别名查回了旧会话，于是新消息、
`/model` 命令、乃至整轮对话全写进了别人的 jsonl。

**正确做法：** 键带每次 spawn 随机生成的 token，`draft:<uuid>|<项目路径>`。
`|` 既不是合法 Windows 路径字符也不出现在 uuid 里，是安全的分隔符；
`draftProjectPath()` 取第一个 `|` 之后的部分，无 `|` 的旧格式整段都是项目路径。
`create()` 接受 `draftKey` 参数，供「句柄被回收后按原键重开」复用。

**验证方式：** 同一项目连续新建两个会话并发消息，断言两者的 `sessionPath` 不同、
落盘的 jsonl 是两个文件、各自的用户消息只出现在自己的文件里。
探针：`temp/verify-draft/probe.mjs`（修复前 4 项失败，修复后全通过）。

### 3c-2. 新建会话只认领「还没说过话」的预热进程

**触发信号：** 同 3c-1；或「读设置页」读到的是别人会话的配置。

**根因：** `claimPrewarmed()` 的实现曾是 `findLive(projectPath)` —— 它返回该项目下
**任意一个**活会话，包括用户正开着的、已经聊了很久的那个。`prewarm()` 也用它判断
「已经预热过了」，于是这个项目永远不再预热。

**正确做法：** 三个方法分工，不要把它们的判据混用。

| 方法 | 认谁 | 用途 |
| --- | --- | --- |
| `findSpare()` | `spare && !initialized && !streaming && !dead` | 预热/认领的判据 |
| `claimPrewarmed()` | 同上，且认领后**清 `spare`** | 新建会话独占一个进程 |
| `findResident()` | 该项目任意 `!dead` 的会话 | 只给「读设置」这类可共享的调用 |
| `findLive()` | 同 `findResident`（历史命名） | 同上，不要用于新建/预热 |

`spare` 必须显式维护：`spawnProcess` 起来是 `true`；`create({spare:false})` 与
`resume()`、`forkSession()` 都必须置 `false` —— 它们承载着一次具体的新建或已有历史。
只靠 `initialized` 不够：认领之后到第一条 prompt 之间，句柄既没 init 也没 streaming，
第二次新建会把它再认领一遍，两个新会话共用一个进程。

**验证方式：** 探针末段「连开两个新会话得到不同 draft 键」。

### 3d. 会话句柄的读取一律走 `registry.get()`，不要直接查 `sessions` 表

`draft:<token>|<项目路径>` 只是临时键；`system:init` 之后句柄会迁到真实 jsonl，旧键进
`aliases` 表。任何「按 sessionPath 找句柄」的方法如果直接 `this.sessions.get()`，
在迁移之后就会找不到 —— 表现为接口突然 404 / 静默失败，而前端手里那个键完全合法。

**已踩过：** `answerPermission` 与 `pendingPermissions` 用直查，权限卡推送正常但
点「允许一次」返回 404；`resume` 用直查，draft 键会重复开一个子进程。
正确做法：所有对外入口统一 `this.get(sessionPath)`，只有迁移/别名维护逻辑本
身才碰 `sessions`。

### 3d-1. 新建会话的首条消息必须由前端**乐观渲染**

**触发信号：** 在新建会话里发出第一条消息后，回复结束前看不到自己打的字；
回复一完又整段出现。

**根因：** 首条 prompt 由 `startDraftSession` 直接 POST（因为 draft 期
`ConversationPane` 给 `useConversation` 传的是 `null`，它的排队投递 effect 不会跑）。
但 `useConversation.send()` 才是唯一会插入乐观用户消息的地方 —— 绕过它，那条消息就
没有任何地方可以渲染：既没有可订阅的会话路径，也没有磁盘转录可读。

**正确做法：** 服务端返回的 draft 键上记一条 `draftFirstMessage{sessionPath,text,images,at}`，
`ConversationPane` 在 `isDraftSession(selected)` 时把它合成进 `MessageList` 的视图
（`messages: [message, ...view.messages]`，同时 `undeliveredPrompts + 1` 让它留在
未接走的一侧）；`renameSessionPath` 时清掉，避免与磁盘那份重复。发送失败要回滚，
否则界面会显示一条根本没在路上发的消息。

**验证方式：** UI 探针在回车后 250ms 截图，此时标题仍为「正在准备会话…」，
而用户气泡已在屏幕上；会话落盘后气泡数量仍为 1（不重复）。见
`temp/verify-draft/ui-probe.mjs`。

### 3e. `--fork-session` 必须先发一条 prompt

`-p` 模式下 `--resume <id> --fork-session` 单独启动时 CLI 一直沉默 —— `system:init`
要等第一条 prompt，新 jsonl 也要等跑完一轮才写。所以只「复制历史不说话」做不到，
fork 必须发一条占位消息（`FORK_OPENER`），它会成为新会话的第一条。

fork 出来的新文件跟着 **cwd** 落目录，所以 fork 必须用原会话的 `projectPath` 启动。

### 4. `settings.json` 的 `env` 优先级高于进程环境变量

实测：显式 `--model` 也压不住 `~/.claude/settings.json` 里 `env.ANTHROPIC_BASE_URL` 指定的
上游和默认模型映射。要覆盖上游**必须**用 `--settings <path>`。

**产品含义：** 不要试图用 env 去改用户配置。只读用户配置，并在 UI 里如实展示当前生效的值。

**踩坑：`--settings` 的相对路径按会话 cwd 解析。** 服务进程的启动目录和会话项目目录不是
一回事，直接把 `ANHE_CLAUDE_WEB_SETTINGS=temp/x.json` 透传下去，CLI 会去
`<项目目录>/temp/x.json` 找，报 `Settings file not found` 并 `code 1` 退出 —— 表现是
`agent_start` 后立刻 `agent_settled` + `session_closed`，没有 `session_renamed`，很容易
误判成中继或流式回归。正确做法：在 `SessionRegistry` 构造时用 `resolve()` 固化成绝对路径。

### 5. 权限模式是六态，`default` 合法

`system:init.permissionMode` 实测回报 `"default"`。

权威取值（来自二进制内 zod schema 的定义原文）：
```
default           标准行为，危险操作弹窗
acceptEdits       自动接受文件编辑
bypassPermissions 绕过全部检查（需 allowDangerouslySkipPermissions）
plan              计划模式，不实际执行工具
dontAsk           不弹窗，未预授权即拒绝
auto              用模型分类器自动批准/拒绝
```
`--help` 里列的是 `…|manual|…`——`manual` 只是 `default` 的展示别名。
`PermissionModeSwitch` 按上面六态实现，`default` 的展示名写作「默认（Manual）」。

### 5.5 权限提问走**内置 MCP 中继**（曾误判为「接不进来」）

**先说结论：能弹权限卡，通路是 `--permission-prompt-tool` + 一个 HTTP 型 MCP 服务器。**

早期结论（「CLI 2.1.309 不把权限提问交给外部进程」）是**错的**，原因是当时只试了
`--permission-prompts host` 与 `--sdk-url` 两条路，没试 `--permission-prompt-tool`：

- `--sdk-url` 确实会被拒：`host "127.0.0.1" is not an approved Anthropic endpoint`。
- 但 `--permission-prompt-tool mcp__<服务器>__<工具>` 是**公开参数**，CLI 需要授权时
  会调用那个 MCP 工具，并把返回的 JSON 文本当裁决。实测（隔离 `CLAUDE_CONFIG_DIR`）：
  ```
  tools/call {"name":"ask","arguments":{
    "tool_name":"Bash",
    "input":{"command":"curl -s https://example.com -o /dev/null"},
    "tool_use_id":"call_…"}}
  ```
  三种返回都被采纳：`allow`（执行）、`allow` + `updatedPermissions`（**真写进
  `settings.json` 的 `permissions.allow`**）、`deny`（工具结果 `is_error: true`，
  原因回给模型）；`deny` + `interrupt: true` 直接 `error_during_execution`。
  `tools/call` 挂起 60 秒 CLI 仍在等 —— 可以一直挂着等用户点按钮。

**实现**（`server/src/permission-relay.ts` + `agent/registry.ts`）：

| 部件 | 做法 |
| --- | --- |
| 形态 | HTTP 型 MCP，端点就是本服务自己的 `POST /api/mcp/permission` —— 不额外起子进程 |
| 关联 | URL 带 `?relay=<每次 spawn 的随机 uuid>`，即「这次调用属于哪个会话」，也是唯一凭据 |
| 配置 | `--mcp-config <临时文件>`；**实测内联 JSON 字符串不被接受**，只有文件路径可以 |
| 追加 | **不加 `--strict-mcp-config`**，否则会把用户自己的 MCP 服务器全屏蔽 |
| 裁决 | `registry.askByRelay()` 把请求挂进 `pending` 并下发 `permission_request`；`answerPermission()` 唤醒那条 Promise |
| 超时 | `PERMISSION_RELAY_TIMEOUT_MS`（默认 30 分钟）到点回 deny，不让一轮永远卡死 |

**永远不用的三条**：`--dangerously-skip-permissions`（硬边界 2）、伪造 SDK 宿主、
「没弹卡就当已批准」。

早期三段式（模式 / 预授权 / 拒绝说明）仍然成立，只是现在**多了真正的一张卡**：
`PermissionRequestCard`（允许一次 / 总是允许 / 拒绝）。

---

### 6. `can_use_tool` 的请求形状（保留备查）

> 注意：**本版走的是 5.5 的 MCP 中继**，不是这条控制平面路径。两者的字段几乎一样
> （中继的 `ask` 参数就是 `tool_name` / `input` / `tool_use_id` /
> `permission_suggestions` / `blocked_path` / `description`），保留本节是因为
> `controls.ts` 的裁决构造仍按这套语义写。


CLI → 宿主（`request` 内，zod 只强制前五项）：
```jsonc
{
  "subtype": "can_use_tool",
  "tool_name": "Bash",
  "display_name": "…",              // 人类可读名
  "input": { … },                   // 工具入参原样，不许裁剪
  "tool_use_id": "toolu_…",
  "description": "…",
  "permission_suggestions": [ … ],  // 可选，用于「总是允许」
  "blocked_path": "…",              // 可选，被规则挡住的路径
  "requires_user_interaction": true,// 可选，必须用户亲自决定
  "tool_kind": "…"                  // 可选
}
```

### 7. `can_use_tool` 的响应形状（容易写错）

响应必须**包在 `control_response` 里**：
```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<原样回传>",
    "response": {
      // 允许
      "behavior": "allow",
      "updatedInput": { … },        // 可选，改写工具入参
      "updatedPermissions": [ … ],  // 可选，持久化权限变更
      "toolUseID": "…",             // 可选
      "decisionClassification": "user_temporary" // 可选
      // 拒绝
      // "behavior": "deny",
      // "message": "拒绝原因，会回给模型",
      // "interrupt": true,         // 可选，同时中断
      // "decisionClassification": "user_reject"
    }
  }
}
```

`decisionClassification` 官方语义：`user_temporary` = 允许一次，`user_permanent` = 总是允许
（点击时以及后续缓存命中都要标这个），`user_reject` = 拒绝。**这正好对应 UI 三个按钮。**

> **这三个按钮现在是活的**，见 5.5：MCP 中继把 `ask` 调用交到
> `PermissionRequestCard`，三个按钮分别对应 `user_temporary` / `user_permanent` /
> `user_reject`，`POST /api/sessions/:id/permissions/:requestId` 就是落点。
> **响应体不再是 `control_response` 信封** —— 中继的 `tools/call` 直接返回
> 这段 JSON 文本；`controls.ts` 的构造仍然复用，只是外层换了。

### 8. `updatedPermissions`（PermissionUpdate）全形

```jsonc
[
  { "type": "addRules",          "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }], "behavior": "allow", "destination": "userSettings" },
  { "type": "replaceRules",      "rules": [ … ], "behavior": "allow", "destination": "…" },
  { "type": "removeRules",       "rules": [ … ], "behavior": "allow", "destination": "…" },
  { "type": "setMode",           "mode": "plan", "destination": "…" },
  { "type": "addDirectories",    "directories": [ "…" ], "destination": "…" },
  { "type": "removeDirectories", "directories": [ "…" ], "destination": "…" }
]
```
`behavior` ∈ `allow | deny | ask`
`destination` ∈ `userSettings | projectSettings | localSettings | session | cliArg`

「总是允许」→ `userSettings`（即 `~/.claude/settings.json`），与终端的 `/permissions` 一致。

### 9. `stream_event` 是真实存在的增量通道

由流式解析器直接 yield，只要 `--include-partial-messages` 打开就会发：
```jsonc
{
  "type": "stream_event",
  "event": { /* 原始 Anthropic SSE: message_start | content_block_start |
                content_block_delta(text_delta|thinking_delta|input_json_delta|signature_delta) |
                content_block_stop | message_delta | message_stop | ping */ },
  "parent_tool_use_id": null,
  "uuid": "…",
  "session_id": "…",
  "ttft_ms": 123                 // 可选
}
```
**没有收到增量 ≠ 协议不支持**，而是上游（尤其是一堆中转代理）没转发 SSE 增量。
`normalize.ts` 必须两条路都支持：有 `stream_event` 走增量，没有就退化成整条 `assistant`
一次性 `message_update`（没有打字机效果，但内容正确）。

### 10. 其它控制子类型

stdin 侧：`interrupt`、`stop_task`、`send_task_message`、`set_permission_mode`、`set_model`、
`set_max_thinking_tokens`、`set_color`、`mcp_toggle`、`message_rated`、`side_question`、`rewindFiles`、`ui_*`
另有 `control_cancel_request`（宿主取消已发出的请求）、`request_user_dialog`（`dialog_kind` + `payload`）。

**`interrupt` 的回执形状（实测）**：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"p1","response":{"still_queued":[]}}}
```

两个坑：

- `request_id` 回显在 `response.response` 那一层，**不在顶层**。按顶层去读会永远拿到
  `undefined`，误以为没回执。
- 这个 `success` 只说明**请求被收下**，不代表已经停。停没停要看随后的 `result`
  （`terminal_reason` / `num_turns`）。
- `--input-format stream-json` 下 CLI **要等 stdin 上第一条消息才开始干活**，
  不发 prompt 就永远没有 `system:init`。所有控制探针都得先写一条 prompt。

### 11. 模型列表全部动态读

- `system:init.model` = 当前实际生效模型
- `~/.claude/settings.json` → `modelPicker.options[].{model,label,description}`、`modelSettings.<model>.effortLevel`
- `--model` 传 `options[].model` 原样

**任何地方都不许硬编码模型名。** 上游换名字、用户改配置，UI 都得跟着变。

### 11b. 上下文摘要走控制查询，不能从空窗口字段推断「没有用量」

**触发信号：** 会话已有回复，输入栏却一直显示「上下文窗口未知」；打开面板后也不更新。

**根因/约束：** 用户配置和历史 jsonl 通常没有窗口容量。CLI 2.1.309 的
`get_context_usage` / `detail: "summary"` 可在没有 prompt、没有 `system:init`
时返回本地上下文估算，不必额外生成回复。成功载荷位于完整事件的
`response.response`；错误文字位于 `response.error`，不带成功载荷。
`maxTokens` 与 `rawMaxTokens` 可能相等，不凭字段名假设两者含义一定不同。

**正确做法：** 运行时优先查询摘要，用 CLI 返回的 `maxTokens` 作分母；失败时只展示
最近一次回复的历史 usage，并标明不是当前占用。缺少窗口时保留已知 token，不猜容量、
不按字符数伪装成实测用量。已观测窗口按会话路径和模型隔离保存，不能推广成模型固定容量。
前端打开面板应重新查询，进程 `live` 不代表上下文数据已获取。查询超时和进程关闭须释放等待者。

**验证方式：** `temp/verify-context-cli.mjs` 在隔离配置下仅查询控制平面，2.1.309
约 1.2 秒返回摘要，`initialized: false`；`temp/verify-context.mjs` 覆盖模拟回执、
历史用量、并发去重、持久化重读、会话/模型隔离以及失败/超时，且确认 jsonl 未修改。

**适用范围：** Claude Code stream-json 上下文面板；CLI 升级时重新验证控制协议。

### 12. 上游可能是坏的 —— 必须首屏提示

本机实测：`settings.json` 把 `ANTHROPIC_BASE_URL` 指向一个 Codex 代理，所有 Claude 请求
返回 `400 unknown provider for model …`。

用户环境里会有同类问题（key 过期、base_url 填错、代理挂了）。**必须**提供
`/api/health/upstream` 做一次最小探针，首屏显示可操作提示，而不是让用户在聊天框里看到一个裸 400。

---

## 二、硬边界（不允许违反，见 SECURITY.md）

1. **默认只绑 `127.0.0.1`**；非本机地址必须显式传入并打印警告；明确不支持反代到公网。
2. **永不硬编码 `--dangerously-skip-permissions`**；默认权限模式永远是 `default`；
   `bypassPermissions` 只能由用户显式切换，且要二次确认 + 持续警告条。
3. **权限卡展示原始入参，不截断、不美化**；服务端转发 `can_use_tool` 时不过滤字段。
4. **日志不落 token / 密钥**；SSE 不发环境变量快照。
5. **会话 jsonl 只读**；写入一律经 CLI 进程或本项目自己的元数据目录。
6. **不内置模型、不内置密钥**；不代理、不缓存、不中转用户的上游流量。

---

## 三、代码组织约定

- **协议细节只允许出现在 `server/src/agent/normalize.ts` 与 `server/src/agent/controls.ts`。**
  其余代码（路由、前端、存储）一律与协议无关。Claude Code 升级导致协议漂移时，
  改动必须能收敛在这两个文件里。
- 前端消费的是归一化之后的 `message_update` 形状，与 pi-web 原有形状保持一致，
  这样 `streaming-json.ts`、`row-model.ts`、`turn-rail.ts` 可以零改动复用。
- 不写 UI 单元测试。保证 `pnpm typecheck` 与 `pnpm build` 通过，人工验收按 README 的
  Todo List 走。

---

## 四、端口占用

- `5319` = pi-web-simple（若同机共存，别撞）
- **`5419` = 本项目默认端口**

---

## 五、品牌图标与「安装到桌面」（实测过的坑）

### 1. 图标只有一个源头：`scripts/brand-assets.py`

`python scripts/brand-assets.py` 一次生成 `web/public/` 下的 `mark.svg`、
`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png`、
`favicon.ico`。**不要手改这些产物** —— 几何（12 射线、长短交替、半径、颜色）
全写在脚本顶部，SVG 和 PNG 都从同一组常量出来。

不依赖 cairosvg/sharp：本机没有，脚本用 Pillow 8 倍超采样自绘（`line` 没有圆头，
两头各盖一个半径 = 线宽一半的圆）。

### 2. `.webmanifest` 必须在 `static.ts` 的 `CONTENT_TYPES` 里

漏了它，文件会以 `application/octet-stream` 送出去，Chrome 就不当清单解析，
表现为「安装入口永远不出现」，而控制台只有一条容易忽略的 MIME 提醒。已加映射。

### 3. 安装资格 = manifest + service worker（+ https/localhost）

`127.0.0.1` 算安全上下文，所以本机可直接装；**局域网 IP（http）装不了**，这是
浏览器的硬规定，不是我们的 bug。

`web/public/sw.js` 只为安装资格存在，不是离线优先策略：

- `/api`（含 SSE）**一律不进 fetch 拦截**，否则界面会显示过期会话状态；
- 导航网络优先，缓存只在服务端没起来时兜底；
- 带指纹的 `assets/` 缓存优先（名字里就有内容哈希，不存在过期）。

`sw.js` 在 `assets/` 之外，所以 `static.ts` 给的是 `no-cache`，这是对的：
它必须每次重新校验，否则装了新版也换不掉 worker。

### 4. `beforeinstallprompt` 必须 `preventDefault()`

不拦默认行为，事件不会被延迟，也就拿不到可 `prompt()` 的句柄，按钮点了没反应。

### 5. `useSyncExternalStore` 的 `getSnapshot` 必须返回稳定引用

`web/src/lib/pwa.ts` 只维护一份 `current` 快照，变了才替换并通知。早期版本每次
调用都 `return { state }`，React 认定快照永远在变 → 无限重渲染（#185），
**打开设置页直接白屏**。任何“每次返回新对象”的 selector 都有这个坑。

### 6. dev 下没有安装入口是预期行为

`registerServiceWorker()` 只在 `import.meta.env.PROD` 里跑（dev 的模块地址带
`?t=` 时间戳，缓存下来只会拿着旧模块）。所以 `pnpm dev` 下浏览器不会给安装图标；
要验证安装能力请 `pnpm build` 后跑 `node cli/bin.js`。

实测验证方式：Chrome headless + CDP，`Page.getInstallabilityErrors` 必须返回
`{ installabilityErrors: [] }`（脚本见 `temp/pwa-check*.mjs`）。
