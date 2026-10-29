# 开发指南

给要改这个项目的人看的。装包用户看 [README](../README.md) 就够了。

## 环境

| 项 | 版本 |
|---|---|
| Node.js | `>=22.19.0` |
| pnpm | `9.15.4`（写在 `package.json` 的 `packageManager` 里） |
| 平台 | Windows / macOS / Linux 都能跑；Windows 上必须 spawn 原生 `claude.exe` |

```sh
pnpm install
```

依赖极少，这是刻意的：

- **server**：零运行时依赖，只有可选的 `node-pty`（终端用，装不上就置灰）
- **web**：React 19、react-markdown、shiki、xterm、clsx

## 目录结构

```
cli/bin.js              发布入口：解析参数 → 起服务 → 开浏览器
server/src/
  index.ts              HTTP 服务与启动
  routes.ts             全部 API 路由（约 1800 行，一张表）
  bus.ts                SSE 广播与订阅过滤
  config.ts             配置与环境变量
  registry.ts           转发出口（实现在 agent/registry.ts）
  agent/                ★ 协议适配层，只在这里碰 Claude Code 细节
    locate.ts           找 claude 可执行文件
    registry.ts         会话进程池：spawn / 回收 / --resume / fork
    normalize.ts        stream-json 事件 → 前端消费的形状
    controls.ts         控制消息编解码、六态权限、权限更新类型
    sessions.ts         读 ~/.claude/projects 下的 jsonl
    models.ts           模型候选（动态读）
    types.ts            协议类型声明
  session-path.ts       draft 键、slug 生成、路径安全
  ...                   右栏 IDE、终端、Git、标题、静态托管
web/src/
  features/conversation/  对话、权限卡、模式开关、工具渲染
  features/rightbar/      IDE 面板
  lib/                    api / sse / app-state / i18n
scripts/
  accept.mjs            端到端验收（HTTP + SSE，52 项断言）
  verify-dist.mjs       发布产物完整性检查
```

## 常用命令

```sh
pnpm dev          # 前端 Vite(5519) + 后端 tsx watch(4419) 并行
pnpm typecheck    # 两个包都做 tsc --noEmit
pnpm build        # web/dist + server/build
pnpm accept       # 端到端验收（需要能连通的模型上游）
pnpm start        # 起发布形态（不开浏览器）
```

开发时三个端口分开：

| 场景 | 端口 |
|---|---|
| 发布版 | 5419 |
| 开发后端 | 4419 |
| 开发前端 | 5519 |
| pi-web-simple（若共存） | 5319 |

`pnpm dev` 后端默认 4419（`server/src/config.ts` 的 `PORT`），Vite 5519 把 `/api`
反代到 4419。发布版没有这一层：`cli/bin.js` 显式传 5419，同一进程同时回答前端与 API。
两套端口刻意分开，开发时不会撞上已在运行的发布版。

## 必须遵守的硬边界

这些不是风格偏好，是踩过坑之后定的。改代码前先读
[PROJECT_RULES.md](../PROJECT_RULES.md)。

### 1. 协议细节只许出现在两个文件里

> `server/src/agent/normalize.ts` 与 `server/src/agent/controls.ts`

Claude Code 的事件与 jsonl 格式是**私有实现细节**，升级就可能变。把协议知识摊进
`routes.ts`、前端或存储层，等于让一次升级变成全仓库改动。

这条规矩的检验方法：改完协议相关的东西，如果 diff 里出现了 `agent/` 之外的文件，
先停下来想清楚为什么。

### 2. 服务端不许 import `web/src/`

`tsc -p tsconfig.build.json` 的 `rootDir` 是 `server/src`，跨包会报
`is not under rootDir`。两边各自持有一份协议类型声明（`agent/types.ts` 与
`web/src/lib/types.ts`）。

### 3. 永不硬编码 `--dangerously-skip-permissions`

默认 `permissionMode` 永远是 `default`。`bypassPermissions` 只能由用户显式切换，
切换要二次确认。这条没有例外。

### 4. 会话 jsonl 只读

`~/.claude/projects/*/*.jsonl` 一律不写。写入一律由 CLI 进程负责。
绕过 CLI 去写等于在一个没有契约的格式上做双写，迟早写坏用户的会话历史。

### 5. 日志不落凭据

不打印 token、API key、`Authorization` 头，不打印环境变量快照。

### 6. 模型列表全动态读

不硬编码任何模型名。`system:init.model` ∪ `settings.json` 的 `modelPicker.options`。

### 7. 默认只绑 `127.0.0.1`

`--host 0.0.0.0` 要打印警告。见 [SECURITY.md](../SECURITY.md)。

## 本项目与上游的差异

界面、会话模型、右栏 IDE 从 [pi-web-simple](https://github.com/woxihejinghao/pi-web)
移植而来（它又是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
Web UI 的移植）。

改了什么、为什么改，见 [design-notes.md](./design-notes.md)。那里也解释了
**为什么权限卡只做了一半**——那是协议限制，不是偷懒。

## 踩过的坑（省你几小时）

### Windows 上不能 `spawn("claude")`

npm 装的是 `.cmd` shim，直接 spawn 会 `ENOENT`。必须找原生 `claude.exe`
（`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`）。
见 `agent/locate.ts`。

### `--input-format stream-json` 下不发 prompt 就不动

CLI 要等 stdin 上第一条消息才开始干活。没发 prompt 就永远没有 `system:init`。
写控制协议探针时先写一条 prompt，否则会误以为「CLI 挂了」。

### `settings.json` 的 `env` 压过一切

优先级高于进程环境变量，甚至压过 `--model`。换上游**只能**用 `--settings <path>`。
而且 `--settings` 是**合并**不是替换。

### 目录 slug 的生成规则：每个非字母数字字符各换一个 `-`

不是把连续的压成一个。`C:\Users\…` 开头是 `C--Users`。压成一个会得到 `C-Users`，
差一个字符就会让同一个会话被当成两个，事件路径与磁盘路径对不上，前端整条事件流跟丢。

### `--fork-session` 必须真跑一轮

单独启动不发 `system:init`；init 后立刻 interrupt 不落盘。所以 fork 必须发一条
占位 prompt，它会成为新会话的第一条。见 `docs/known-limitations.md`。

### CRLF

仓库里 server/web 的源文件是 CRLF。用脚本做多行文本替换会**静默失败**
（`assert in` 通过了但写回没生效）。改文件用编辑器/`edit` 工具，或按行号处理。

### Windows 短名

`mkdtempSync` 可能返回 `ADMINI~1`，必须 `realpathSync.native` 展开，
否则路径比较会出错。验收脚本里已经处理。

## 添加一个 API 路由

1. 在 `server/src/routes.ts` 里加 `route("GET", "/api/...", handler)`。
2. 协议相关的转换放在 `agent/`，不要在 handler 里直接解析 Claude Code 的原始事件。
3. 写路由一律用 `allowedPath()` 校验路径，别信客户端传来的路径。
4. 如果新事件要推给前端，在 `bus.ts` 登记，并检查 `wantsFrame` 的过滤逻辑。
5. 在 `scripts/accept.mjs` 里加断言。**没有断言的接口等于没做。**

## 添加一个前端工具渲染

1. 在 `web/src/features/conversation/tool-map.ts` 里登记工具名 → 组件。
2. 组件放 `features/conversation/`，样式用 CSS Modules。
3. 入参**完整展示**，不截断。截断会让用户无法判断自己在批准什么。

## 验收脚本怎么写

`scripts/accept.mjs` 是纯 HTTP + SSE，手写了 SSE 客户端。写新断言时注意：

- **等待一律用单调 `seq`**（`record.seq = events.length`），不要用时间戳。
- `stream.waitFor(predicate, timeoutMs)` 超时会 **reject**，不是返回 null。要 `try/catch`。
- 发消息的字段名是 **`message`**，不是 `text`。
- 用 `mkdtempSync` 隔离工作目录，并用 `realpathSync.native` 展开 8.3 短名。
- 别只断言「接口返回 200」——那个 200 也可能什么都没做。要验副作用。

## 发布

见 [release.md](./release.md)。一句话：`pnpm typecheck && pnpm build &&
node scripts/verify-dist.mjs && pnpm accept` 全绿，再 `npm publish`。
