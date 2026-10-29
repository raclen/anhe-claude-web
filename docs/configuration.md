# 配置

全部通过命令行参数或环境变量控制。不设时用下表默认值。

## 命令行

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-p, --port <端口>` | `5419` | 监听端口。前端与 API 都在这个端口上 |
| `--host <地址>` | `127.0.0.1` | 监听地址。**填非本机地址会打印警告**，见 [SECURITY.md](../SECURITY.md) |
| `--no-open` | 关（即默认会开浏览器） | 启动后不自动打开浏览器 |
| `-h, --help` / `-v, --version` | — | 帮助 / 版本 |

## 环境变量

同名参数优先于环境变量；两者都没设才用默认值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ANHE_CLAUDE_WEB_PORT` | `5419` | 等同 `--port` |
| `ANHE_CLAUDE_WEB_HOST` | `127.0.0.1` | 等同 `--host` |
| `ANHE_CLAUDE_WEB_OPEN` | `1` | 设为 `0` 等同 `--no-open` |
| `ANHE_CLAUDE_WEB_HOME` | `~/.anhe-claude-web` | 本项目的**自有**元数据目录（项目记录、UI 偏好、标题缓存）。**不是** `~/.claude`，两者互不写入 |
| `ANHE_CLAUDE_WEB_STATIC_DIR` | 自动探测 `web/dist` | 前端构建产物位置。非空即启用静态托管，空串强制只跑 API |
| `ANHE_CLAUDE_WEB_IDLE_MS` | `600000` | 会话空闲多久后回收其 `claude` 子进程 |
| `ANHE_CLAUDE_WEB_MAX_SESSIONS` | `8` | 同时存活的 `claude` 子进程上限 |
| `ANHE_CLAUDE_WEB_SETTINGS` | 空（不传） | 启动 `claude` 时额外传 `--settings <path>`。**必须用它换上游**：`settings.json` 的 `env` 优先级高于进程环境变量和 `--model`，而且 `--settings` 是**合并**不是替换 |
| `CLAUDE_CODE_PATH` | 自动探测 | 指定 Claude Code 可执行文件。自动探测失败时用，见下 |

### 不常用的调优项

一般不用设，出问题时才用。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ANHE_CLAUDE_WEB_SSE_BUFFER` | `4194304`（4 MB） | SSE 每连接的缓冲上限。事件积压超过它会被丢弃，防止内存失控 |
| `ANHE_CLAUDE_WEB_SESSION_DIR` | 空（用 `~/.claude/projects`） | 会话目录覆盖。测试和多账号场景用 |
| `ANHE_CLAUDE_WEB_TITLE_BYTES` | `120` | 自动标题的最大字节数 |
| `ANHE_CLAUDE_WEB_TITLE_WORDS` | `8` | 截断式标题的单词数 |
| `ANHE_CLAUDE_WEB_TITLE_INPUT_BYTES` | `2000` | 送去 LLM 生成标题的输入上限 |
| `ANHE_CLAUDE_WEB_TITLE_OUTPUT_TOKENS` | `32` | 标题生成的输出 token 上限 |
| `ANHE_CLAUDE_WEB_TITLE_TIMEOUT_MS` | `10000` | 标题生成超时 |
| `ANHE_CLAUDE_WEB_SKIP_TITLE_MIGRATION` | 关 | 设为 `1` 跳过标题迁移。迁移卡住时用 |

## 关于 `CLAUDE_CODE_PATH`

本项目**不打包** Claude Code，只在运行时探测你机器上已经装好的那个。探测顺序：

1. `CLAUDE_CODE_PATH`
2. npm 全局的 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`（Windows）
3. `%APPDATA%\npm\claude.exe`（Windows）
4. `PATH` 上的 `claude.exe`
5. （Linux/macOS）`PATH` 上的 `claude`
6. 最后才退回用 shell 调 `claude.cmd` / `claude.ps1`

找不到时页面首屏会直接告诉你，并给出 `npm i -g @anthropic-ai/claude-code` 的提示，
而不是等到你发第一条消息才报错。

## 与 `~/.claude` 的关系

本项目**读**这些（只读）：

| 路径 | 用途 |
|---|---|
| `~/.claude/projects/*/*.jsonl` | 会话历史。项目分组取每行的 `cwd`，标题取 `summary` 行 |
| `~/.claude/settings.json` | 模型列表（`modelPicker.options`）、`modelSettings`、当前生效的 `env` |
| `~/.claude.json` | 用户级 `mcpServers` |
| `~/.claude/skills`、`~/.claude/plugins` | 技能与插件（第一版只读展示） |

**唯一会写 `~/.claude` 的情形**：你在权限卡上点「总是允许」。这时服务端把
`updatedPermissions: [{ type: "addRules", behavior: "allow", destination: "userSettings" }]`
交给 Claude Code CLI，由 CLI 自己去写 `~/.claude/settings.json`——本项目不直接改那个文件。
行为与你终端里用 `/permissions` 完全一致。

除此之外，本项目的所有自有状态都在 `ANHE_CLAUDE_WEB_HOME`（默认 `~/.anhe-claude-web`）。

## Anthropic 相关的环境变量

`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 等**由 Claude Code 自己**
从它的 `settings.json` 和你的 shell 环境读取，本项目不解释、不改写、不打印。

注意一个实测坑：**`~/.claude/settings.json` 里的 `env` 优先级高于进程环境变量**。
所以你在 shell 里 `export ANTHROPIC_BASE_URL=…` 未必生效。要确认当前到底走哪个上游，
看页面右上角的上游健康状态，或者直接看 `settings.json`。
