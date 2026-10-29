# Third-Party Notices / 第三方声明

`anhe-claude-web` 的界面与部分服务端逻辑**移植、改编自**下列上游项目。上游均为 MIT
许可，允许复制、修改与再分发，**前提是保留其版权声明与许可文本**——本文件即为
履行该义务而存在，随源码与 npm 包一并分发，不得移除。

本文件只覆盖**被复制进本仓库**的代码与设计资源。通过 npm 安装的运行时依赖
（React、Vite、shiki 等）由各自的包分发其许可，不在本文件范围内。

本项目**不随包分发任何 Anthropic 模型、密钥或 Claude Code 二进制**：它只在你自己的机器上
启动你已安装的 `claude` 命令。Claude Code 本身由 Anthropic 依其条款分发，与本项目许可无关。

---

## 1. pi-web-simple

- 上游：<https://github.com/woxihejinghao/pi-web>
- 许可：MIT
- 版权：Copyright (c) 2026 pi-web-simple contributors

本项目的**绝大部分代码是 pi-web-simple 的直接移植**：`server/src/` 与 `web/src/` 整体取自
该仓库，随后把「驱动 pi coding agent」的适配层换成「驱动 Claude Code CLI」。保留的是
会话/项目/工作区模型、SSE 事件总线、对话渲染管线、IDE 右栏、终端、主题与设计语言。

被替换或新增的部分（本项目原创）：

| 位置 | 说明 |
|---|---|
| `server/src/agent/locate.ts` | 探测本机 Claude Code 可执行文件（Windows 上必须绕开 npm 的 `.cmd` shim） |
| `server/src/agent/registry.ts` | 每会话一个 `claude -p --input-format stream-json` 子进程，含空闲回收与单写者约束 |
| `server/src/agent/normalize.ts` | 把 Claude Code 的 `stream_event` / `assistant` 归一成 Web 端已消费的消息更新形状 |
| `server/src/agent/controls.ts` | `control_request` / `control_response` 编解码，权限门控的唯一入口 |
| `server/src/agent/sessions.ts` | 扫 `~/.claude/projects/*/*.jsonl`，用行内 `cwd` 反推项目 |
| `web/src/features/conversation/PermissionCard.tsx` | 权限确认卡（允许一次 / 总是允许 / 拒绝） |
| `web/src/features/conversation/PermissionModeSwitch.tsx` | 权限模式切换（六态） |
| `web/src/features/conversation/tool-map.ts` | Claude Code 工具名 → 展示组件映射 |

MIT 许可全文（pi-web-simple 原件）：

```
MIT License

Copyright (c) 2026 pi-web-simple contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. deepseek-harness (dsh)

- 上游：<https://github.com/deepseek-ai/deepseek-harness>
- 许可：MIT
- 版权：Copyright (c) 2026 DeepSeek

pi-web-simple 的界面又是 dsh Web UI 的移植，本项目**继承**了这层血缘：排版层级、尺寸度量、
动效、文案与设计 token 大量照搬其原件，其中一部分是**逐字节**复制（源文件注释中标注为
`byte-identical`、`verbatim` 或 `Ported from`）。具体范围：

| 本仓库位置 | 与 dsh 的关系 |
|---|---|
| `web/src/components/dsh-icons.tsx` | Figma glyph 路径数据**逐字节相同**（仅外层 React 包装是本项目的） |
| `web/src/components/icons.tsx` | 部分 glyph 取自 dsh（如 `GaugeIcon` = dsh 的 `IconGaugeOutline16`），各 glyph 处已标注 |
| `web/src/theme/design-platform.css` | `--dsw-*` / `--dsh-*` 设计 token 表逐字移植，含四个深色主题块 |
| `web/src/theme/gradient-shadow-text.css` | 渐变与阴影 token 表 |
| `web/src/theme/scrollbar.css` | 滚动条皮肤与其消费的 `--dsw-alias-scrollbar-*` token |
| `web/src/theme/corner-shape.css` | `--dsw-corner-shape` 圆角 token |
| `web/src/theme/shiki.css` | shiki `css-variables` 主题的 `--shiki-*` 取值 |
| `web/src/features/settings/*` | 设置页骨架与文案（各组件标注 `Ported from dsh's …`） |
| `web/src/features/conversation/*` | `DisclosureRow`、`TurnStatus`、`TurnNavigator`、`RetryNotice`、`row-model` 等移植自 dsh 原件 |
| `web/src/features/conversation/highlight.ts` | shiki 语言表与别名表照抄 dsh |
| `server/src/store.ts` | 会话显示偏好（transcript-mode、正文字号边界）移植自 dsh |

MIT 许可全文（dsh 原件）：

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. @earendil-works/pi-coding-agent

- 上游：<https://github.com/earendil-works/pi-coding-agent>
- 许可：MIT（依据该包 `package.json` 的 `license` 字段；上游仓库与已发布包均未附带 `LICENSE` 文件，因此此处不转录版权行）
- 说明：**本项目不再依赖此包**（它是 pi-web-simple 的运行时依赖，本项目替换为裸 Claude Code 协议）。
  下表只是移植过程中被复制进本仓库、尚未重写的那部分：

| 本仓库位置 | 与 pi 的关系 | 本项目状态 |
|---|---|---|
| `server/src/composer.ts` | `estimateContextTokens` 按 pi 未导出的同名实现重建 | 待按 Claude Code 的 usage 字段重写 |
| `server/src/extensions.ts` | `withOverride` 复制自 `pi config` | 待改为只读展示 `~/.claude/settings.json` |
| `server/src/session-path.ts` | 镜像 pi 私有的 `getDefaultSessionDirPath` | 待改为 `~/.claude/projects` |
| `server/src/models.ts` | provider 对象的重建逻辑遵循 `pi-ai` 未导出的实现 | 待改为读 Claude Code 的 `modelPicker.options` |
| `web/src/features/conversation/skill-block.ts` | 移植 pi 的 `parseSkillBlock` 正则 | 保留（Claude Code 的 skill 块格式不同，待适配） |

---

## 4. Anthropic Claude Code

- 上游：<https://claude.com/product/claude-code>（npm 包 `@anthropic-ai/claude-code`）
- 许可：Anthropic 商业条款（**非** MIT）

本项目**不重新分发** Claude Code：不把二进制打进 npm 包，也不在安装时下载它。
运行时只在你自己的机器上探测并启动**你已经安装**的 `claude` 命令，因此该软件的使用
受你与 Anthropic 之间的条款约束。本项目只通过它的公开命令行接口
（`--input-format stream-json` / `--output-format stream-json`）与之通信。

协议事实（事件形状、`control_request` 子类型、权限模式取值等）是通过观察该命令行接口的
实际输出得到的，记录在 `PROJECT_RULES.md` 中，不包含任何 Anthropic 源码。

---

## 5. 其它第三方资源

- **shiki** 及其语法/主题数据：本项目只消费其公开 API（`@shikijs/*` 通过 `shiki` 包引入），
  语言表的选择是产品决定，见上表。
- **npm 依赖树**：截至开源时的扫描结果全部为宽松许可（MIT / ISC / Apache-2.0 / BSD-3-Clause / 0BSD），
  无 copyleft 依赖。
