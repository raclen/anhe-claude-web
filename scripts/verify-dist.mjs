#!/usr/bin/env node
// 发布前的产物检查：npm 包里必须带上能跑的东西。
// 这个脚本在 prepublishOnly 里跑，缺任何一项就 abort，避免发一个装不上就用不了的包。
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  ["cli/bin.js", "CLI 入口"],
  ["server/build/index.js", "服务端构建产物（pnpm build）"],
  ["web/dist/index.html", "前端构建产物（pnpm build）"],
  ["LICENSE", "许可文本"],
  ["THIRD_PARTY_NOTICES.md", "第三方声明（MIT 义务要求）"],
  ["SECURITY.md", "安全边界"],
  ["README.md", "说明"],
];

const missing = [];
for (const [rel, why] of REQUIRED) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    missing.push(`${rel} — ${why}`);
    continue;
  }
  if (statSync(abs).isDirectory()) {
    missing.push(`${rel} — 是目录，期望文件`);
  }
}

if (missing.length > 0) {
  console.error("verify-dist: 发布产物不完整，已中止：\n");
  for (const line of missing) console.error(`  ✗ ${line}`);
  console.error("\n先跑 `pnpm build`。");
  process.exit(1);
}

// 服务端构建产物不能引用到 devDependencies 里的东西（tsx / typescript 不随包发布）。
const { readdirSync, readFileSync } = await import("node:fs");
const buildDir = join(ROOT, "server", "build");
const offenders = [];
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith(".js")) continue;
  const text = readFileSync(join(buildDir, name), "utf8");
  for (const dep of ["tsx", "vitest", "typescript"]) {
    if (text.includes(`from "${dep}`) || text.includes(`require("${dep}`)) {
      offenders.push(`${name} → ${dep}`);
    }
  }
}
if (offenders.length > 0) {
  console.error("verify-dist: 构建产物引用了 devDependency，安装后会跑不起来：\n");
  for (const line of offenders) console.error(`  ✗ ${line}`);
  process.exit(1);
}

console.log(`verify-dist: OK（${REQUIRED.length} 项产物齐全）`);
