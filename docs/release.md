# 发布流程

给维护者自己看的清单。发布到 npm 是**不可撤销**的（72 小时后连撤回都不行），
所以每一步都要先验。

## 0. 前置：登录

本机默认 registry 是 `registry.npmmirror.com`，**它不能发布**。本项目的
`publishConfig.registry` 已经写死 `https://registry.npmjs.org/`，所以 `npm publish`
会走 npmjs，但**认证必须是对 npmjs 的**。

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/   # 必须打印出用户名
```

如果 `npm whoami` 报 `ENEEDAUTH`，先别往下走。

## 1. 验一遍全绿

```sh
pnpm typecheck
pnpm build
node scripts/verify-dist.mjs
pnpm accept            # 需要能连通的模型上游；49 项断言必须全过
```

`pnpm accept` 会自动起一个隔离 HOME 的服务端，用
`temp/test-settings.json` 指向上游。**不要**把带真实凭据的 settings 提交进仓库。

## 2. 本地试装

```sh
npm pack
npm i -g ./anhe-claude-web-<version>.tgz
anhe-claude-web --version
anhe-claude-web --no-open    # 起来后访问 http://127.0.0.1:5419
npm uninstall -g anhe-claude-web
```

装完要确认：`--version` 正常、首页能开、`/api/meta/cli` 能找到自己的 `claude`。
这一步能抓到「打包漏文件」「`files` 白名单写窄了」这类只在别人机器上才爆的错。

## 3. 版本号

`0.0.x` = 占名/试发，功能不完整，README 里要写清楚。
`0.1.0` = 第一个「能日常用」的版本。

```sh
npm version patch   # 或 minor / 手动改 package.json
```

## 4. 发布

```sh
npm publish
```

`prepublishOnly` 会自动再跑 `pnpm typecheck && pnpm build && node scripts/verify-dist.mjs`。
任何一项失败都会中止发布 —— 这是故意的，别用 `--ignore-scripts` 绕过。

发布后立刻验：

```sh
npm view anhe-claude-web version dist.tarball
npx anhe-claude-web@latest --version
```

## 5. 出问题时

- **72 小时内**：`npm unpublish anhe-claude-web@<version>` 可以撤。撤完这个版本号
  **永久作废**，不能再发同号。
- **超过 72 小时**：只能 `npm deprecate anhe-claude-web@<version> "原因"` 再发新版。

## 绝对不要做

- 不要 `npm publish --access restricted`（本项目 `publishConfig.access: public`）。
- 不要把 `temp/test-settings.json`、`.probe-env.json` 或任何带 token 的文件放进
  `files` 白名单。
- 不要在 CI 里传模型凭据去跑 `pnpm accept`。
- 不要因为 `prepublishOnly` 报错就用 `--ignore-scripts` —— 那是最后一道防线。
