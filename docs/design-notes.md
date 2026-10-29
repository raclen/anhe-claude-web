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

## 四、前端最大的一处新增：权限确认

pi-web 没有这个界面——因为 pi 的权限模型不同。Claude Code 每次要跑工具都会阻塞，
等宿主回一个决定。所以本项目新增：

- **`PermissionCard`**：展示 `display_name` + **原始 `input` 对象（不截断、不美化）**，
  三个按钮对应 Claude Code 的 `decisionClassification`：
  - 「允许一次」→ `behavior: "allow"` + `user_temporary`
  - 「总是允许」→ `behavior: "allow"` + `user_permanent` +
    `updatedPermissions: [{ type: "addRules", …, destination: "userSettings" }]`
  - 「拒绝」→ `behavior: "deny"` + `user_reject` + 一句回给模型的原因
- **`PermissionModeSwitch`**：六态。`plan` 模式顶部挂横幅（它在计划，不会动手）；
  `bypassPermissions` 切换要二次确认，开启期间常驻警告条。
- **`tool-map.ts`**：Claude Code 的工具名 → 展示组件。`Bash` 渲染成命令块、
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

## 九、端口

`5419`。pi-web-simple 用 `5319`，同机共存时不会撞。
