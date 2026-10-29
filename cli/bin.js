#!/usr/bin/env node
// 已发布包的唯一入口：一个进程同时提供构建好的前端与 API，
// 所以 `npx anhe-claude-web` 就是完整的安装故事。
//
// 默认端口 5419：与开发服务器显示在地址栏的端口一致，装好后不用记第二个数字。
// 默认只绑 127.0.0.1 —— 这个界面能操控本机的 Claude Code，暴露到公网等于把
// 机器交出去。只有显式 `--host 0.0.0.0` 才放行，并且会打印警告。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `anhe-claude-web — 本地 Web 界面，驱动你已安装的 Claude Code CLI

用法：
  anhe-claude-web [选项]

选项：
  -p, --port <端口>   监听端口（默认 5419）
      --host <地址>   监听地址（默认 127.0.0.1；填 0.0.0.0 会把本机能力暴露到网络）
      --no-open       启动后不自动打开浏览器
  -h, --help          显示本帮助
  -v, --version       显示版本

环境变量：
  ANHE_CLAUDE_WEB_PORT   等同 --port
  ANHE_CLAUDE_WEB_HOST   等同 --host
  ANHE_CLAUDE_WEB_OPEN   设为 0 等同 --no-open
  CLAUDE_CODE_PATH       指定 Claude Code 可执行文件路径（自动探测失败时用）
`;

function fail(message) {
  process.stderr.write(`anhe-claude-web: ${message}\n`);
  process.exit(1);
}

function readVersion() {
  const raw = readFileSync(join(HERE, "..", "package.json"), "utf8");
  return JSON.parse(raw).version;
}

function parseArgs(argv) {
  const opts = {
    port: process.env.ANHE_CLAUDE_WEB_PORT ?? "5419",
    host: process.env.ANHE_CLAUDE_WEB_HOST ?? "127.0.0.1",
    open: process.env.ANHE_CLAUDE_WEB_OPEN !== "0",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) fail(`${arg} 需要一个值`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "-p":
      case "--port":
        opts.port = next();
        break;
      case "--host":
        opts.host = next();
        break;
      case "--no-open":
        opts.open = false;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "-v":
      case "--version":
        process.stdout.write(`${readVersion()}\n`);
        process.exit(0);
        break;
      default:
        fail(`未知参数 ${arg}（试试 --help）`);
    }
  }

  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`端口不合法：${opts.port}`);
  }
  return { port, host: opts.host, open: opts.open };
}

const { port, host, open } = parseArgs(process.argv.slice(2));

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  process.stderr.write(
    [
      "",
      `  ⚠️  你正在把 anhe-claude-web 绑定到非本机地址：${host}`,
      "",
      "     这个界面可以直接操控本机的 Claude Code —— 读写文件、执行命令。",
      "     暴露到网络上等于把这些能力交给任何能访问该端口的人。",
      "     请确认你清楚在做什么，并且前面有可信的认证层。",
      "",
      "",
    ].join("\n"),
  );
}

// 服务端读这三个变量，统一由 CLI 决定，避免两处默认值漂移。
process.env.ANHE_CLAUDE_WEB_PORT = String(port);
process.env.ANHE_CLAUDE_WEB_HOST = host;
process.env.ANHE_CLAUDE_WEB_OPEN = open ? "1" : "0";

try {
  await import("../server/build/index.js");
} catch (error) {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write(
      [
        "anhe-claude-web: 没有找到构建产物。",
        "",
        "如果你是开发者，请先执行：",
        "  pnpm install && pnpm build",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  throw error;
}
