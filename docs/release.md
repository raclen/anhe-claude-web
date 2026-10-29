# 发布流程

这份文档写给要发版的人。**发布到 npm 是不可撤销的**：72 小时后就撤不回来了，
所以每一步都要先验、再发。

当前状态（`0.1.0` 已发布）：

| 项 | 值 |
|---|---|
| 包名 | `anhe-claude-web` |
| 当前版本 | `0.1.0` |
| npm 主页 | https://www.npmjs.com/package/anhe-claude-web |
| 维护者账号 | `raclen` |
| 默认分支 | `master`（CI 也监听 `master`） |
| 构建工具 | pnpm `9.15.4`、Node `>=22.19.0` |

---

## 0. 前置：npm 登录

本机默认 registry 是 `registry.npmmirror.com`，**它不能发布**。本项目
`package.json` 里的 `publishConfig.registry` 已写死 `https://registry.npmjs.org/`，
所以 `npm publish` 会走 npmjs——但**认证必须是针对 npmjs 的**。

```sh
npm whoami --registry=https://registry.npmjs.org/
```

打印出用户名（`raclen`）才能继续。报 `ENEEDAUTH` 就先登录：

```sh
npm login --registry=https://registry.npmjs.org/
```

### 账号开了 2FA 怎么办

`raclen` 这个账号用的是 **WebAuthn 安全密钥**，不是 6 位动态码。两种做法：

**A. 用 Bypass-2FA 的 granular token（推荐，适合频繁发版）**

1. 打开 https://www.npmjs.com/settings/raclen/tokens/new
2. 点「Use security key」并通过验证（**这一步必须本人碰硬件，无法自动化**）
3. 按下表填：

   | 字段 | 值 |
   |---|---|
   | Token name | 随便，如 `anhe-claude-web-publish` |
   | Bypass two-factor authentication | **勾上** |
   | Packages and scopes → Permissions | `Read and write` |
   | Packages and scopes → 范围 | `All packages`（选 `Only select packages` 会得到「0 packages」，发不出去） |

4. 点 Generate token，**立刻复制**——只显示一次
5. 写进 `~/.npmrc`：

   ```sh
   printf '//registry.npmjs.org/:_authToken=%s\n' 'npm_xxxxxxxx' > ~/.npmrc
   ```

> **注意**：这类 token 默认 **7 天过期**（最长 90 天），且能写所有包，属于高权限凭证。
> 别提交进仓库、别贴到公开的地方。npm 已宣布 2027 年 1 月起取消
> granular token 的「直接发布」能力，届时改走 staged publishing。

**B. 每次手动过 2FA**

```sh
npm publish
```

浏览器会弹安全密钥提示，碰一下即可。适合偶尔发一次。

---

## 1. 发版前必须全绿

按顺序跑，**任何一项红了就停下**，不要往下走。

```sh
pnpm install --frozen-lockfile
pnpm typecheck              # server + web 两个包都要过
pnpm build                  # web/dist + server/build
node scripts/verify-dist.mjs
pnpm accept                 # 端到端，需要能连通的模型上游
```

### 关于 `pnpm accept`

这是发布前的**最后一道真实验证**：它起一个隔离 `HOME` 的服务端，用纯 HTTP + SSE
跑 52 项断言（会话创建、流式输出、多轮上下文、权限模式、中断、fork、用量、
只读边界、路径穿越防护、进程回收与 `--resume` 恢复）。

- 它会自动读 `temp/test-settings.json` 指向上游。该文件**含真实凭据，绝不提交**。
- 没有上游时只能验到「CLI 能起来」，对话类断言会失败——那种情况下别发版。
- 想指定别的配置：`pnpm accept --settings <path>`。
- 想打已有服务端：`node scripts/accept.mjs --base http://127.0.0.1:5419`。

**必须看到的输出**：`全部通过：52 项断言`。

---

## 2. 本地试装（别跳过）

这一步能抓到「打包漏文件」「`files` 白名单写窄了」这类**只在别人机器上才爆**的错。
本仓库自己的 `node_modules` 在，所以工作区里跑得好不代表包能装。

```sh
npm pack
npm i -g ./anhe-claude-web-<version>.tgz
anhe-claude-web --version        # 打印版本号
anhe-claude-web --no-open        # 起来后访问 http://127.0.0.1:5419
```

打开页面确认三件事：

1. 首页能开（不是白屏）
2. `/api/meta/cli` 能找到你的 `claude`
3. 发一条消息能收到回复

验完卸掉：

```sh
npm uninstall -g anhe-claude-web
rm -f anhe-claude-web-*.tgz
```

### 顺手查一遍包里有没有敏感文件

```sh
npm pack --dry-run --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const f=JSON.parse(s)[0].files.map(x=>x.path);
  console.log("总文件:",f.length);
  console.log("含 json:", f.filter(x=>x.endsWith(".json")));
  console.log("可疑:", f.filter(x=>/setting|probe-env|\.env|token|secret/i.test(x)));
})'
```

正常应只有 `package.json` 一个 json，可疑项为空。

---

## 3. 版本号

```sh
npm version patch   # 0.1.0 → 0.1.1（修 bug）
npm version minor   # 0.1.0 → 0.2.0（加功能）
npm version major   # 0.1.0 → 1.0.0（破坏性变更）
```

本项目约定：

| 版本 | 含义 |
|---|---|
| `0.0.x` | 占名 / 试发，功能不完整 |
| `0.1.x` | 第一个「能日常用」的版本线，修 bug 走 patch |
| `0.x.0` | 加功能 |

`npm version` 会自动改 `package.json` 并打一个 git tag。**别忘了 push tag**。

---

## 4. 发布

```sh
git status                 # 确认工作区干净
npm publish
```

`prepublishOnly` 会自动再跑一遍 `pnpm typecheck && pnpm build && node scripts/verify-dist.mjs`。
任何一项失败都会中止发布——这是故意的，**不要用 `--ignore-scripts` 绕过**。

### 发布后立刻验证

```sh
npm view anhe-claude-web version dist-tags --registry=https://registry.npmjs.org/
```

期望：`version = '0.1.x'`、`dist-tags = { latest: '0.1.x' }`。

### ⚠️ 会看到 `0.0.0-stage`，别慌

npm 有 **staged publishing** 机制：`npm publish` 成功后，registry 上会先出现一个
`0.0.0-stage` 占位包（描述是 `Temporary package placeholder for staged publishing`），
正式版本要**等十几秒到几十秒**才同步出来。

```sh
# 可能还看不到新版本
npm view anhe-claude-web versions

# 等 20 秒再查
sleep 20 && npm view anhe-claude-web versions
```

**看到 `0.0.0-stage` 不等于发布失败，千万不要立刻重发。** 判断成功的正确方式：

```sh
curl -s https://registry.npmjs.org/anhe-claude-web | head -c 400
# 或者直接看网页
curl -s -o /dev/null -w "%{http_code}\n" https://www.npmjs.com/package/anhe-claude-web
```

#### `0.0.0-stage` 删不掉，也不影响

实测（2026-10-29）：

```sh
npm unpublish anhe-claude-web@0.0.0-stage
# → 403 Granular access tokens that bypass two-factor authentication may not perform this action.
```

Bypass-2FA 的 token 不能做 unpublish。要删得用本人 2FA 手动验证，或去
网页 `Settings → Staged Packages`——但那里通常是空的，因为这个版本不是
「等审批的暂存版」，而是 npm 为 staged publishing 流程留的**占位元数据**
（337 字节的壳，不是真实的包内容）。

**它就是历史记录里的一个名字，`latest` 不指向它、`npm i anhe-claude-web`
不会装到它。放着不管就行。**

### 最终验收：从公共 registry 全新装一次

```sh
cd /tmp && rm -rf npxcheck && mkdir npxcheck && cd npxcheck
npm i anhe-claude-web --registry=https://registry.npmjs.org/
node -e "console.log(require('anhe-claude-web/package.json').version)"
./node_modules/.bin/anhe-claude-web --no-open
```

能起来、能访问 `http://127.0.0.1:5419/api/health` 返回 `{"ok":true,...}` 才算真发对了。

---

## 5. 出问题怎么办

| 情况 | 处理 |
|---|---|
| 刚发完发现有严重 bug | **72 小时内**：`npm unpublish anhe-claude-web@<version>`。撤掉的版本号**永久作废**，不能重发同号 |
| 超过 72 小时 | 只能 `npm deprecate anhe-claude-web@<version> "原因"`，然后发新版修掉 |
| 发错 tag | `npm dist-tag add anhe-claude-web@<version> latest` 改回来 |
| `EOTP` 报错 | 缺 2FA。见上面第 0 节的两种做法 |
| `E403` 且提示权限 | token 权限不够，或范围选了「Only select packages」却没选包 |

---

## 6. 绝对不要做

- **不要** `npm publish --access restricted`（本项目 `publishConfig.access: public`）。
- **不要**把 `temp/test-settings.json`、`.probe-env.json` 或任何带 token 的文件放进
  `files` 白名单。
- **不要**在 CI 里传模型凭据去跑 `pnpm accept`。凭据泄露一次就得换。
- **不要**因为 `prepublishOnly` 报错就用 `--ignore-scripts`——那是最后一道防线。
- **不要**看到 `0.0.0-stage` 就判定失败去重发。
- **不要**把 Bypass-2FA 的 token 提交进仓库或贴进 issue/截图。

---

## 7. CI 做什么、不做什么

`.github/workflows/ci.yml`，触发于 push 到 `master`、PR、手动。

做：`pnpm install --frozen-lockfile` → `typecheck` → `build` → `verify-dist` → `npm pack` → 上传 tarball。

**不做**：`pnpm accept`。因为它需要一个能连通的模型上游，那是密钥，不进 CI。
端到端验收一律本地跑，由人盯着看结果。

**CI 不发布。** 发布是本地手动、带 2FA 的动作，刻意不自动化。

---

## 8. 完整流程速查

```sh
# 0. 确认登录
npm whoami --registry=https://registry.npmjs.org/

# 1. 全绿
pnpm install --frozen-lockfile && pnpm typecheck && pnpm build \
  && node scripts/verify-dist.mjs && pnpm accept
#    ↑ 必须看到「全部通过：52 项断言」

# 2. 试装
npm pack && npm i -g ./anhe-claude-web-*.tgz
anhe-claude-web --version && anhe-claude-web --no-open   # 开页面看一眼，然后 Ctrl+C
npm uninstall -g anhe-claude-web && rm -f anhe-claude-web-*.tgz

# 3. 版本号
npm version patch

# 4. 发布
git status && npm publish

# 5. 验证（等 20 秒，因为 staged publishing）
sleep 20 && npm view anhe-claude-web version dist-tags \
  --registry=https://registry.npmjs.org/

# 6. 推 tag
git push && git push --tags
```
