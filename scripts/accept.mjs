#!/usr/bin/env node
/**
 * 端到端验收：只用 HTTP + SSE，不开浏览器。
 *
 * 为什么是脚本而不是 UI 单测：本项目约定不写 UI 测试，但「Claude Code 的进程能不能
 * 被这个 Web 层正确驱动」必须能被机器验证 —— 每次升级 CLI 都可能悄悄改协议。
 * 这里断言的都是**跨进程可见的事实**（jsonl 落了什么、SSE 发了什么事件），
 * 而不是某个组件渲染成什么样。
 *
 * 用法：
 *   node scripts/accept.mjs                     # 自起一个临时服务端，跑完关掉
 *   node scripts/accept.mjs --base http://127.0.0.1:5419   # 打到已跑着的服务端
 *
 * 前置：本机装了 `claude`，且它有可用的上游（否则只有 A 组能过）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5419;

// --- 小工具 ------------------------------------------------------------------

let passed = 0;
const failures = [];

/** 记一条通过。组名写清楚，失败时一眼能看出卡在哪一步。 */
function ok(name, detail = "") {
  passed += 1;
  console.log(`  \u001b[32m\u2713\u001b[0m ${name}${detail ? ` \u001b[2m${detail}\u001b[0m` : ""}`);
}

/** 记一条失败并继续跑 —— 一个失败的断言不该掩盖后面五个。 */
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.log(`  \u001b[31m\u2717\u001b[0m ${name} \u001b[2m${detail}\u001b[0m`);
}

function assert(name, condition, detail = "") {
  if (condition) ok(name, detail);
  else fail(name, detail || "condition was falsy");
  return condition;
}

function assertEq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return assert(name, same, same ? String(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const enc = (value) => encodeURIComponent(value);

/** 一次性 HTTP 调用，非 2xx 抛错并带上响应体（错误信息在体里，不在状态行里）。 */
async function call(method, path, body, base) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text === "" ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "object" && data !== null ? (data.error ?? data.message) : data;
    throw new Error(`${method} ${path} \u2192 ${res.status}: ${message ?? text.slice(0, 200)}`);
  }
  return data;
}

const get = (path, base) => call("GET", path, undefined, base);
const post = (path, body, base) => call("POST", path, body ?? {}, base);

// --- SSE ---------------------------------------------------------------------

/**
 * 开一条 SSE，把事件按到达顺序攒起来。
 *
 * 用 `fetch` 手搓而不是 `EventSource`：Node 没有 EventSource，且我们需要
 * `AbortController` 精确控制关闭时机 —— 关错了会把服务端的心跳计时器留在那。
 */
function openStream(base) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  let connectionId = null;
  let buffer = "";

  const flush = () => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split < 0) return;
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = "message";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) continue;
      let payload = null;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      if (name === "hello") connectionId = payload?.connectionId ?? null;
      const record = { name, at: Date.now(), seq: events.length, payload };
      events.push(record);
      for (const waiter of [...waiters]) waiter(record);
    }
  };

  const ready = (async () => {
    const res = await fetch(`${base}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SSE \u2192 ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          flush();
        }
      } catch {
        /* abort 是我们自己干的，不是错误 */
      }
    })();
    return res;
  })();

  return {
    ready,
    events,
    get connectionId() {
      return connectionId;
    },
    /** 等到第一条满足条件的事件；已到过的也算（避免竞态）。 */
    async waitFor(predicate, timeoutMs = 90_000) {
      const seen = events.find(predicate);
      if (seen) return seen;
      return await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          // 超时时把最后几条事件打出来 —— 否则只能看到「超时」两个字，
          // 看不出是没发事件、还是发了但我们匹配的条件写错了。
          const tail = events
            .slice(-6)
            .map(
              (r) =>
                `${r.payload?.event?.type ?? r.name}|${String(r.payload?.sessionPath ?? "?")}`,
            )
            .join(", ");
          rejectPromise(new Error(`SSE 等待超时 (${timeoutMs}ms)。最后 12 条：${tail}`));
        }, timeoutMs);
        waiters.push((record) => {
          if (!predicate(record)) return;
          clearTimeout(timer);
          resolvePromise(record);
        });
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** 只关心「某个会话」的 session_event。 */
const sessionEvent = (path, type) => (record) =>
  record.name === "session_event" && record.payload?.sessionPath === path && record.payload?.event?.type === type;

// --- 临时环境 ----------------------------------------------------------------

/**
 * 一个只属于本次运行的 HOME。
 *
 * 不碰用户真实的 `~/.claude` 和 `~/.claude.json`：验收脚本会在里面写会话文件、
 * 注册项目，跑到一半失败也不该污染主人的日常环境。
 */
function makeIsolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "anhe-accept-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  // 复制用户的 settings.json 里的上游配置？不。用调用方给的，没有就留空 ——
  // 留空时 CLI 会走它自己的默认上游，本机已登录就能跑通。
  return home;
}

/**
 * 起服务端，等到 `/api/health` 应答。
 *
 * 直接 spawn `node cli/bin.js`，走的和用户 `npx anhe-claude-web` 完全同一条路径 ——
 * 验收要验的是发布物，不是某个内部函数。
 */
async function startServer(home, workDir, settingsPath) {
  const child = spawn(process.execPath, [join(ROOT, "cli", "bin.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ANHE_CLAUDE_WEB_PORT: String(PORT),
      ANHE_CLAUDE_WEB_OPEN: "0",
      // 隔离 HOME 意味着拿不到用户自己的 `~/.claude/settings.json`，
      // 也就没有上游配置。验收一律跑一个显式上游，否则只能验到「CLI 能起来」。
      ...(settingsPath === null ? {} : { ANHE_CLAUDE_WEB_SETTINGS: settingsPath }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr.on("data", (chunk) => log.push(chunk.toString()));

  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`服务端 45s 内没起来。日志：\n${log.join("")}`);
    }
    try {
      const health = await get("/api/health", base);
      if (health?.ok) return { child, base, log };
    } catch {
      /* 还没监听，再等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 尽力杀掉，Windows 上必须走 taskkill 才会带走 claude 子进程。 */
async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经没了 */
    }
  }
}

// --- 验收主体 ----------------------------------------------------------------

async function main() {
  const explicit = process.argv.includes("--base")
    ? process.argv[process.argv.indexOf("--base") + 1]
    : null;

  let home = null;
  let child = null;
  let base = explicit;
  let log = [];

  if (explicit) {
    console.log(`\n打到已有服务端 ${explicit}\n`);
  } else {
    home = makeIsolatedHome();
    console.log(`\n临时 HOME: ${home}`);
    // 默认拿项目里的 `temp/test-settings.json`（指向本机上游），也可以用
    // `--settings <path>` 指定。找不到就警告：那种情况下只能跑 A/B/E 组。
    const settingsArg = process.argv.includes("--settings")
      ? process.argv[process.argv.indexOf("--settings") + 1]
      : join(ROOT, "temp", "test-settings.json");
    const settingsPath = settingsArg && existsSync(settingsArg) ? settingsArg : null;
    if (settingsPath === null) {
      console.log(
        "\u001b[33m警告\u001b[0m 没找到上游 settings（temp/test-settings.json），" +
          "对话类断言会因为没有模型而上游失败。用 --settings <path> 指定。",
      );
    }
    const started = await startServer(home, null, settingsPath);
    child = started.child;
    base = started.base;
    log = started.log;
    console.log(`服务端就绪 ${base}\n`);
  }

  const stream = openStream(base);
  await stream.ready;
  // `hello` 可能比我们的 flush 晚一点到，等一下拿到 connectionId。
  for (let i = 0; i < 50 && stream.connectionId === null; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }

  let workDir = null;
  try {
    // === A. 基础元信息 ======================================================
    console.log("A. 基础元信息");

    const health = await get("/api/health", base);
    assert("health.ok", health?.ok === true, JSON.stringify(health));

    const cli = await get("/api/meta/cli", base);
    if (!cli?.ok) {
      // 没有 CLI 时后面全部无意义，直接报清楚并退出。
      fail("meta/cli 找到 claude", cli?.message ?? JSON.stringify(cli));
      throw new Error("本机没找到 claude CLI，验收无法继续");
    }
    ok("meta/cli 找到 claude", `${cli.version} (${cli.source})`);
    assert("meta/cli 给出路径", typeof cli.path === "string" && cli.path.length > 0, cli.path);

    const upstream = await get("/api/health/upstream", base);
    assert("health/upstream.cli.found", upstream?.cli?.found === true);
    assert(
      "health/upstream 只报键名不报值",
      Array.isArray(upstream?.envKeys) &&
        upstream.envKeys.every((key) => typeof key === "string" && !key.includes("=")),
      (upstream?.envKeys ?? []).join(","),
    );

    const sseId = stream.connectionId;
    assert("SSE 拿到 connectionId", typeof sseId === "string" && sseId.length > 0, String(sseId));

    const models = await get("/api/meta/models", base);
    assert("meta/models 返回列表", Array.isArray(models?.models), `${models?.models?.length ?? 0} 个候选`);

    // === B. 项目 ============================================================
    console.log("\nB. 项目注册");

    // 必须用 `realpathSync.native`：Windows 上 `TMP` 常是 8.3 短名
    // （`ADMINI~1`），而**非** native 版本只展开符号链接、不展开短名，
    // 服务端那边会解析成长名，直接比字符串会假失败。
    workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "anhe-work-")));
    writeFileSync(join(workDir, "hello.txt"), "hello from accept\n", "utf8");

    // 项目已注册时服务端回 400 —— 那不是失败，是「本来就登记过了」。
    // 所以这里两条路都接受，并统一从列表里取权威的那一条。
    const existing = (await get("/api/projects", base)).find((p) => p.path === workDir);
    const project = existing ?? (await post("/api/projects", { path: workDir }, base));
    assert("创建/复用项目", typeof project?.id === "string", project?.id);
    assertEq("项目路径原样返回", project?.path, workDir);
    const projectId = project.id;

    const projects = await get("/api/projects", base);
    assert("项目出现在列表里", projects.some((p) => p.id === projectId));

    // === C. 会话创建与流式对话 ==============================================
    console.log("\nC. 会话与流式输出");

    const created = await post("/api/sessions", { projectId }, base);
    assert("新建会话返回 draft 路径", String(created?.sessionPath ?? "").startsWith("draft:"), created?.sessionPath);
    await post("/api/events/subscription", { connectionId: sseId, sessionPath: created.sessionPath }, base);

    const promptStarted = Date.now();
    const sent = await post(`/api/sessions/${enc(created.sessionPath)}/prompt`, {
      message: "只回复两个字：收到。不要调用任何工具。",
    }, base);
    assert("prompt 被接受", sent?.ok === true, JSON.stringify(sent));
    // 第一条 prompt 之后会话才会拿到 id 和 jsonl 路径；在那之前它还是 draft 键。
    const draftPath = sent?.sessionPath ?? created.sessionPath;
    assert("draft 键以 draft: 开头", String(draftPath).startsWith("draft:"), String(draftPath));

    // 服务端会广播 `session_renamed`（旧键 → 真实 jsonl 路径）。这条是前端的
    // 唯一出路：没有它，订阅方永远停在 draft 键上。所以先断言它存在。
    const renamedFrame = await stream.waitFor(
      (r) =>
        r.name === "session_event" &&
        r.payload?.event?.type === "session_renamed" &&
        r.payload?.event?.previousPath === draftPath,
    );
    const sessionPath = renamedFrame.payload.event.sessionPath;
    assert("收到 session_renamed", typeof sessionPath === "string" && !String(sessionPath).startsWith("draft:"), String(sessionPath));
    assert("改名事件带的路径指向 jsonl", String(sessionPath).endsWith(".jsonl"), String(sessionPath));

    const initFrame = await stream.waitFor(
      sessionEvent(sessionPath, "session_init"),
      45_000,
    ).catch(() => null);
    // session_init 可能先于改名到达（改名是在收到 init 时才发起的），两种顺序都接受。
    const init = initFrame?.payload?.event ?? renamedFrame.payload.event;
    assert(
      "session_init 报出会话 id",
      typeof init?.sessionId === "string" && init.sessionId.length > 0,
      String(init?.sessionId),
    );

    // 切订阅到真实路径，否则后续事件全部漏掉。
    await post("/api/events/subscription", { connectionId: sseId, sessionPath }, base);
    assert(
      "session_init 报出模型",
      typeof initFrame.payload.event.model === "string",
      initFrame.payload.event.model,
    );

    // 增量事件是 `message_update`，文本 delta 嵌在 `assistantMessageEvent` 里 ——
    // 事件类型从来不是 `text_delta` 本身，别按那个等。
    const deltaFrame = await stream.waitFor(
      (r) =>
        r.name === "session_event" &&
        r.payload?.sessionPath === sessionPath &&
        r.payload?.event?.type === "message_update" &&
        r.payload?.event?.assistantMessageEvent?.type === "text_delta",
    );
    const delta = deltaFrame.payload.event.assistantMessageEvent.delta;
    assert("收到流式文本增量", typeof delta === "string" && delta.length > 0, JSON.stringify(delta));

    const endFrame = await stream.waitFor(sessionEvent(sessionPath, "message_end"));
    assert("收到 message_end", Array.isArray(endFrame.payload.event.message?.content));

    const resultFrame = await stream.waitFor(sessionEvent(sessionPath, "turn_result"));
    const elapsed = Date.now() - promptStarted;
    assert("收到 turn_result", typeof resultFrame.payload.event === "object");
    ok("首轮耗时", `${(elapsed / 1000).toFixed(1)}s`);

    await stream.waitFor(sessionEvent(sessionPath, "agent_settled"));
    ok("收到 agent_settled（一轮收尾）");

    // === D. 多轮上下文 ======================================================
    console.log("\nD. 多轮上下文");

    // 用事件序号而不是时间戳：序号单调，时间戳在同一毫秒里会撞。
    const markSeq = stream.events.length;
    await post(`/api/sessions/${enc(sessionPath)}/prompt`, {
      message: "我刚才让你回复的是哪两个字？只答那两个字。",
    }, base);
    await stream.waitFor(
      (r) => r.seq >= markSeq && sessionEvent(sessionPath, "agent_settled")(r),
    );
    const history = await get(`/api/sessions/${enc(sessionPath)}/messages`, base);
    const messages = history.messages ?? [];
    const userTurns = messages.filter((m) => m.role === "user").length;
    assert("两轮都进了历史", userTurns >= 2, `${userTurns} 条 user、共 ${messages.length} 条`);
    assert("forkPoints 与 user 轮数一致", (history.forkPoints ?? []).length === userTurns,
      `${(history.forkPoints ?? []).length} vs ${userTurns}`);

    // === E. 刷新恢复（jsonl 快照） ==========================================
    console.log("\nE. 从磁盘恢复");

    const snapshotRes = await get(`/api/sessions/${enc(sessionPath)}/messages`, base);
    const snapshot = snapshotRes.messages ?? [];
    const hasAssistant = snapshot.some((m) => m.role === "assistant");
    assert("磁盘快照含 assistant 消息", hasAssistant, `${snapshot.length} 条`);
    const restoredText = JSON.stringify(snapshotRes);
    assert("快照里没有未解析的占位", !restoredText.includes("\"undefined\""));

    // === F. 权限模式 ========================================================
    console.log("\nF. 权限模式");

    const modeRes = await post(`/api/sessions/${enc(sessionPath)}/permission-mode`, { mode: "plan" }, base);
    assert("切到 plan 成功", modeRes?.ok === true, JSON.stringify(modeRes));
    assertEq("回显新模式", modeRes?.permissionMode, "plan");

    const badMode = await fetch(`${base}/api/sessions/${enc(sessionPath)}/permission-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "definitely-not-a-mode" }),
    });
    assert("非法模式被拒绝", badMode.status === 400, `status ${badMode.status}`);

    const perms = await get(`/api/sessions/${enc(sessionPath)}/permissions`, base);
    assert("permissions 返回 pending 数组", Array.isArray(perms?.pending), JSON.stringify(perms));

    // 切回 default：本产品默认值，别把验收环境留在 plan 上。
    await post(`/api/sessions/${enc(sessionPath)}/permission-mode`, { mode: "default" }, base);
    ok("切回 default");

    // === G. 中断 ============================================================
    console.log("\nG. 中断");

    const beforeAbort = Date.now();
    await post(`/api/sessions/${enc(sessionPath)}/abort`, {}, base);
    ok("abort 被接受（无活动轮次时也应为幂等成功）", `${Date.now() - beforeAbort}ms`);

    // 真打一次：发一个会让模型长输出、且会调工具的任务，跑起来后立刻 abort。
    // 只验「接口返回 200」是不够的 —— 那个 200 也可能是什么都没做。
    const abortMark = stream.events.length;
    await post(
      `/api/sessions/${enc(sessionPath)}/prompt`,
      { message: "请用 Bash 工具执行 `node -e \"setTimeout(()=>{},45000)\"`，等它结束再告诉我。" },
      base,
    );
    // 等到真的开始干活再打断，否则打的是空气。
    let started = false;
    try {
      await stream.waitFor(
        (r) => r.seq >= abortMark && r.payload?.event?.type === "message_start",
        90_000,
      );
      started = true;
    } catch {
      started = false;
    }
    assert("长任务已开跑", started, started ? "已收到 message_start" : "90s 内没有开跑");

    const beforeInterrupt = Date.now();
    const abortRes = await post(`/api/sessions/${enc(sessionPath)}/abort`, {}, base);
    assert("运行中 abort 返回成功", abortRes?.ok === true, JSON.stringify(abortRes));

    // 真正的判据：这一轮必须比不打断时早得多地结束。
    let settled = false;
    try {
      await stream.waitFor(
        (r) => r.seq >= abortMark && sessionEvent(sessionPath, "agent_settled")(r),
        90_000,
      );
      settled = true;
    } catch {
      settled = false;
    }
    const stopMs = Date.now() - beforeInterrupt;
    assert("打断后很快就收尾", settled && stopMs < 60_000, `${stopMs}ms`);

    // === H. usage 与统计 ====================================================
    console.log("\nH. 用量统计");

    const usage = await get(`/api/sessions/${enc(sessionPath)}/usage`, base);
    assert("usage 有 usage 桶", typeof usage?.usage === "object", JSON.stringify(usage?.usage));
    assert("usage 有轮数", typeof usage?.turns === "number", String(usage?.turns));
    assert(
      "usage 的 token 数不全为 0",
      (usage?.usage?.input ?? 0) + (usage?.usage?.output ?? 0) > 0,
      JSON.stringify(usage?.usage),
    );

    // === I. fork ============================================================
    console.log("\nI. 分叉");

    // fork 的目标是 forkPoints 里的 entryId（= 那条 user 行的 uuid），不是消息的 id。
    const forkTarget = (snapshotRes.forkPoints ?? [])[0];
    if (!forkTarget) {
      fail("能拿到 fork 目标", "forkPoints 为空");
    } else {
      const forked = await post(`/api/sessions/${enc(sessionPath)}/fork`, { entryId: forkTarget.entryId }, base);
      // Claude Code 的语义是「生成一个新会话文件」，新文件在 sessionFile 里；
      // sessionPath 仍是原会话 —— 这两个字段一样才是 bug。
      const forkedFile = forked?.sessionFile;
      assert("fork 返回了新会话文件", typeof forkedFile === "string" && forkedFile.length > 0, String(forkedFile));
      assert("fork 出来的是另一个文件", forkedFile !== sessionPath, `${forkedFile} vs ${sessionPath}`);
      const origStill = (await get(`/api/sessions/${enc(sessionPath)}/messages`, base)).messages ?? [];
      assert("原会话未被截断", origStill.length >= snapshot.length, `${origStill.length} vs ${snapshot.length}`);
    }

    // === J. 内置命令 ========================================================
    console.log("\nJ. 内置命令");

    const cmd = await post(`/api/sessions/${enc(sessionPath)}/command`, { name: "session", args: "" }, base);
    assert("内置 /session 有回话", typeof cmd?.message === "string" && cmd.message.length > 0, String(cmd?.message).slice(0, 60));

    const badCmd = await fetch(`${base}/api/sessions/${enc(sessionPath)}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rm-rf-everything", args: "" }),
    });
    assert("未知命令被拒绝", badCmd.status >= 400, `status ${badCmd.status}`);

    // === K. 会话列表与标题 ==================================================
    console.log("\nK. 会话列表");

    const list = await get(`/api/projects/${enc(projectId)}/sessions`, base);
    assert("项目下能看到会话", (list?.total ?? 0) >= 1, `${list?.total} 个`);
    const mine = list.sessions.find((s) => s.path === sessionPath);
    assert("会话标题非空", typeof mine?.title === "string" && mine.title.length > 0, mine?.title);
    assert("会话有消息计数", (mine?.messageCount ?? 0) > 0, String(mine?.messageCount));

    // === L. 只读边界 ========================================================
    console.log("\nL. 只读边界（写路由必须拒绝）");

    for (const [label, path, body] of [
      ["模型 provider 写入", "/api/models/providers", { id: "x" }],
      ["扩展写入", "/api/extensions", {}],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert(`${label}被拒绝`, res.status >= 400, `status ${res.status}`);
    }

    // === M. 路径安全 ========================================================
    console.log("\nM. 路径安全");

    const traversal = await fetch(`${base}/api/sessions/${enc("../../../../etc/passwd")}/messages`);
    assert("目录穿越被拒绝", traversal.status >= 400, `status ${traversal.status}`);

    // === N. 空闲回收后 resume ===============================================
    console.log("\nN. 回收后恢复");

    const before = (await get("/api/health", base)).activeSessions;
    ok("当前活动会话数", String(before));
    const resumeSeq = stream.events.length;
    // 这里不真的等 idle 超时（那是分钟级），只验证「已落盘的会话能被重新打开」。
    const reopened = await post(`/api/sessions/${enc(sessionPath)}/prompt`, {
      message: "还在吗？只答『在』。",
    }, base);
    assert("已落盘会话能继续聊", reopened?.ok === true, JSON.stringify(reopened));
    const after = await stream.waitFor(
      (r) => r.seq >= resumeSeq && sessionEvent(sessionPath, "agent_settled")(r),
    );
    assert("恢复后一轮正常收尾", typeof after === "object");

  } catch (err) {
    fail("未捕获异常", err instanceof Error ? err.message : String(err));
    if (log.length > 0) {
      console.log("\n--- 服务端日志 ---");
      console.log(log.join("").slice(-3000));
    }
  } finally {
    stream.close();
    if (child) await stopServer(child);
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发文件占用，留着也不影响 */
      }
    }
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* 同上 */
      }
    }
  }

  // --- 汇总 ------------------------------------------------------------------
  console.log("");
  if (failures.length === 0) {
    console.log(`\u001b[32m全部通过：${passed} 项断言\u001b[0m`);
    process.exit(0);
  }
  console.log(`\u001b[31m${failures.length} 项失败\u001b[0m，${passed} 项通过`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

await main();
