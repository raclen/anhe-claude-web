# anhe-claude-web

**你本机 Claude Code 的网页界面。** 一个命令启动，接着用你已经在用的那个 `claude`。

```sh
npx anhe-claude-web
```

打开 `http://127.0.0.1:5419`。

- **不内置模型，不内置密钥。** 它不替你调用任何 API，只是驱动你本机的 `claude` 命令。
- **与终端完全同步。** 会话、模型列表、权限设置都来自同一份 `~/.claude`。
  在网页里聊的，回到终端 `claude --resume` 能接着聊。
- **默认只听本机。** 这个界面能读写文件、执行命令，所以它默认只绑 `127.0.0.1`。

## 为什么会有这个项目

Claude Code 在终端里很好用，但有几件事终端天生不擅长：

- 看清一次工具调用到底动了什么（diff、文件路径、命令全文）
- 在批准一个操作之前，把它的入参完整看一遍
- 同时开着几个会话
- 在一堆历史会话里找到上个月那个

这个项目把 [pi-web-simple](https://github.com/woxihejinghao/pi-web) 的界面搬过来，
把驱动层从 pi 换成 Claude Code CLI。界面与交互设计源自
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，署名见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 前置条件

1. **Node.js >= 22.19**
2. **已安装并配置好 Claude Code CLI**

   ```sh
   npm i -g @anthropic-ai/claude-code
   claude --version      # 确认能用
   ```

   本项目**不会**帮你装 Claude Code，也不会读你的密钥。它只是找到你已经装好的那个并启动它。

## 用法

```sh
npx anhe-claude-web                 # 默认 http://127.0.0.1:5419
npx anhe-claude-web --port 8080     # 换端口
npx anhe-claude-web --no-open       # 不自动开浏览器
```

完整参数与环境变量见 [docs/configuration.md](./docs/configuration.md)。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 对话 | 流式输出、思考折叠、工具调用卡片、Markdown + 代码高亮 |
| **权限模式** | 六态切换：`default` / `acceptEdits` / `plan` / `dontAsk` / `auto` / `bypassPermissions`；危险模式二次确认 |
| **拒绝可见** | 工具被拒时不静默失败，展示 Claude Code 报的原始原因（不截断）+ 「怎么放开」清单 |
| 中断与续聊 | 随时打断；会话落盘，刷新页面从 `~/.claude/projects` 恢复 |
| 多会话并行 | 每个会话一个独立 `claude` 子进程；空闲自动回收，再聊自动 `--resume` |
| 模型切换 | 列表从你的 `settings.json` 动态读，不写死 |
| 右栏 IDE | 文件树、Git 变更、终端、文件预览 |
| 斜杠命令 | Claude Code 自己的 `commands[]` 全量接进来，另加内置的 `/clear` `/compact` `/cost` |

> **关于「弹出权限确认卡片」：本版本做不到，但不是偷懒。**
> Claude Code 2.1.309 只允许 Anthropic 批准的 SDK 宿主接收 `can_use_tool` 提问，
> 第三方宿主用 `--sdk-url` 会被直接拒（`host "127.0.0.1" is not an approved
> Anthropic endpoint`）。所以权限仍然由 CLI 自己按你 `settings.json` 的
> `permissions` 规则判定 —— 本界面能做的是**切换模式**、**如实展示被拒原因**，
> 以及在你显式点击后才往配置里写一条 allow 规则。详见
> [docs/known-limitations.md](./docs/known-limitations.md)。

## 安全

**默认只绑 `127.0.0.1`，没有认证。** 不要放到公网反向代理后面。要远程访问用 SSH 转发：

```sh
ssh -NL 5419:127.0.0.1:5419 you@your-box
```

本项目**永不**硬编码 `--dangerously-skip-permissions`。默认权限模式永远是 `default`。
`bypassPermissions` 只能由你显式切换，切换要二次确认，开启期间页面顶部常驻警告。

细节见 [SECURITY.md](./SECURITY.md)。

## 常见问题

**启动就提示找不到 Claude Code**

说明自动探测失败。手动指定：

```sh
CLAUDE_CODE_PATH=/path/to/claude npx anhe-claude-web
```

Windows 上常见原因是 npm 全局目录不在 `PATH` 里。真正的可执行文件在
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。

（顺带一个坑：直接 `spawn("claude")` 在 Windows 上会 ENOENT，因为 npm 装的是 `.cmd` shim。
本项目内部已经处理，你不需要管。）

**版本不匹配 / 协议报错**

本项目实测基线是 `@anthropic-ai/claude-code@2.1.309`。Claude Code 升级后如果事件格式变了，
表现通常是「消息发出去没有回应」或「会话列表显示不全」。请先 `claude --version` 确认版本，
然后开 issue 附上版本号。协议相关的改动被刻意收敛在
`server/src/agent/normalize.ts` 与 `server/src/agent/controls.ts` 两个文件里，修起来快。

**首屏说上游不可用**

你的 `~/.claude/settings.json` 里 `ANTHROPIC_BASE_URL` / token 可能配错了。
先用终端跑一次 `claude -p "hi"` 确认，能通再来开网页。

注意：**`settings.json` 的 `env` 优先级比 shell 环境变量高**。
你在 shell 里 `export ANTHROPIC_BASE_URL=…` 未必生效。

**打字机效果没有，整段一次性出现**

你的上游不转发 SSE 增量。内容是对的，只是没有动效。换一个转发增量的上游就有。

**会话列表里少了某些会话**

本项目按 jsonl 行内的 `cwd` 分组，并跳过读不出来的行。如果某次升级改了格式，
可能有会话显示不全。日志里会有记录。

**为什么没看到权限确认卡片？**

见上面「能做什么」里的说明：这个版本的 Claude Code 不向第三方宿主发 `can_use_tool`。
想放宽权限，两条路：在界面右下角切权限模式（推荐，可逆），或者改
`~/.claude/settings.json` 的 `permissions.allow`。

**分叉（fork）出来的会话为什么多了一句奇怪的话？**

这是 CLI 的限制，不是 bug。Claude Code 的 `--fork-session` 要等新会话跑完一轮才把
jsonl 写出来，而 `system:init` 也要等第一条 prompt。所以「只复制历史、不说话」做不到，
必须发一条占位消息。原会话不会被改一个字节。

**新会话刚建好，刷新页面就没了？**

新建会话在发出第一条消息之前只存在于内存里（路径是 `draft:<项目目录>`），没有 jsonl。
发一条消息之后 CLI 才会生成真文件。这是 Claude Code 的行为，不是丢数据。

## 文档

| 文档 | 看什么 |
|---|---|
| [docs/configuration.md](./docs/configuration.md) | 全部参数与环境变量、`CLAUDE_CODE_PATH` 探测顺序、与 `~/.claude` 的关系 |
| [docs/known-limitations.md](./docs/known-limitations.md) | **装之前先扫一遍**：做不到什么、为什么 |
| [docs/design-notes.md](./docs/design-notes.md) | 架构、进程模型、事件流、API 地图、为什么权限卡只做了一半 |
| [docs/network-and-privacy.md](./docs/network-and-privacy.md) | 数据流向、本项目主动发起的网络请求 |
| [SECURITY.md](./SECURITY.md) | 安全边界 |
| [docs/development.md](./docs/development.md) | 改代码：目录结构、硬边界、踩过的坑 |
| [docs/release.md](./docs/release.md) | 发版：完整清单，含 2FA 与 staged publishing 的坑 |
| [PROJECT_RULES.md](./PROJECT_RULES.md) | 实测出来的协议事实与不允许违反的硬边界 |

## 开发

```sh
pnpm install
pnpm dev          # 前端 Vite(5519) + 后端 tsx watch(4419)
pnpm typecheck
pnpm build
pnpm accept       # 端到端验收（52 项断言，需要能用的 claude）
```

改协议相关的东西之前，先读 [PROJECT_RULES.md](./PROJECT_RULES.md)——
那里记着实测出来的协议事实和几条不允许违反的硬边界。
更细的开发说明见 [docs/development.md](./docs/development.md)。

要发布新版本，照 [docs/release.md](./docs/release.md) 的清单走。

## 发布状态

| 项 | 值 |
|---|---|
| npm | https://www.npmjs.com/package/anhe-claude-web |
| 最新版本 | `0.1.0` |
| 实测基线 | `@anthropic-ai/claude-code@2.1.309` |
| 许可 | MIT |

> npm 上还会看到一个 `0.0.0-stage`。那是 npm staged publishing 的占位包，
> 不是正式版本，`latest` 指向真正的版本。详见
> [docs/release.md](./docs/release.md#会看到-000-stage别慌)。

## License

MIT。界面与部分服务端逻辑移植自 pi-web-simple 与 deepseek-harness（均 MIT），
详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

本项目不重新分发 Claude Code，也不含任何 Anthropic 模型或密钥。

---

English: a local web UI for the Claude Code CLI you already have installed.
`npx anhe-claude-web` serves `127.0.0.1:5419` and drives your `claude` binary over its
public `--input-format stream-json` / `--output-format stream-json` interface. No bundled
models, no bundled keys, no telemetry, no proxy in the middle. Binds loopback by default
because the UI can read files and run commands. Ships no Electron app.
