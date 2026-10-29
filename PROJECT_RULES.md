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

`POST /api/sessions` 返回 `draft:<项目路径>`（会话还没有 jsonl）。第一条 prompt 之后
CLI 才发 `system:init` 给出 `session_id`，此时服务端把句柄键改到真实的
`<sessionId>.jsonl` 并广播一条 `session_renamed{previousPath, sessionPath}`。

**这条事件必须送到订阅旧键（`draft:…`）的流上**（见 `bus.ts` 的 `wantsFrame`），
否则订阅方永远停在 draft 键上，之后一条事件都收不到。前端靠它改 `selectedSessionPath`
并重新订阅。

### 3d. `--fork-session` 必须先发一条 prompt

`-p` 模式下 `--resume <id> --fork-session` 单独启动时 CLI 一直沉默 —— `system:init`
要等第一条 prompt，新 jsonl 也要等跑完一轮才写。所以只「复制历史不说话」做不到，
fork 必须发一条占位消息（`FORK_OPENER`），它会成为新会话的第一条。

fork 出来的新文件跟着 **cwd** 落目录，所以 fork 必须用原会话的 `projectPath` 启动。

### 4. `settings.json` 的 `env` 优先级高于进程环境变量

实测：显式 `--model` 也压不住 `~/.claude/settings.json` 里 `env.ANTHROPIC_BASE_URL` 指定的
上游和默认模型映射。要覆盖上游**必须**用 `--settings <path>`。

**产品含义：** 不要试图用 env 去改用户配置。只读用户配置，并在 UI 里如实展示当前生效的值。

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

### 5.5 **`can_use_tool` 接不进来（本版最重要的一条结论）**

实测确认：`claude` CLI 2.1.309 **不会把权限提问交给本进程**。

- `--permission-prompts host` 下，`permissions.ask: ["Bash"]` 的结果只有
  `system:permission_denied`，**一个 `can_use_tool` 请求都没有**。
- 二进制里的 `Y1n({permissionPromptTool, sdkUrl})` 返回 `n ? "stdio" : e` ——
  只有当给了 `sdkUrl` 才把权限通道标成 stdio 宿主。
- 而 `--sdk-url` 会被明确拒绝：
  `host "127.0.0.1" is not an approved Anthropic endpoint`。

**所以产品上不弹权限卡。** 权限改成三段式，全部用 CLI 已有的公开机制：

| 层 | 做法 |
| --- | --- |
| 模式 | 六态直接传给 `--permission-mode`（公开参数，实测可用） |
| 预授权 | 「总是允许」写 `~/.claude/settings.json` 的 `permissions.allow`，**只由用户显式点击触发** |
| 兜底 | 工具被拒时 CLI 发 `system:permission_denied`（带 `tool_name` / `message` / `decision_reason_type`），UI 如实渲染 + 指引 |

完整证据链见 `E:\code\Oracle	emp\claude-proto\FINDINGS.md` 第 11 节。

**绝不**为了「让权限卡能弹」而挂 `--dangerously-skip-permissions`。

---

### 6. `can_use_tool` 的请求形状（保留备查）

> 注意：本节描述的是协议形状，**本版接不到它**（见 5.5）。
> 若将来 CLI 开放了宿主回调，按本节实现即可。


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

> **注意：这三个按钮在本版是跑不到的。** 见第 11 节——`can_use_tool` 只对 Anthropic
> 认可的 SDK 宿主开放，第三方宿主拿不到权限提问。协议与代码都备好了
> （`controls.ts` 的 `decideAllow` / `decideAlwaysAllow` / `decideDeny`，以及
> `POST /api/sessions/:id/permissions/:requestId`），但运行时用不上。
> 界面上实际存在的是 `PermissionDeniedCard`：只展示拒绝原因，没有按钮。

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
