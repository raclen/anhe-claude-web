/**
 * PWA「安装到桌面」的状态机。
 *
 * 三件不同的事被这一个模块收在一起，因为它们回答的是同一个问题
 * ——「现在能不能装、装了没」：
 *
 * 1. **Chromium 系**：`beforeinstallprompt` 事件带来一个 `prompt()` 句柄，
 *    只有把它存住并在用户点击时调用，才会弹出安装对话框。事件可能在本模块
 *    被 import 之前就发出，所以这里一被求值就挂监听，不等任何组件挂载。
 * 2. **iOS Safari**：没有那个事件，也没有可编程安装。唯一的路是让用户点
 *    「分享 → 添加到主屏幕」，所以这里只报告「能不能装」和「怎么装」。
 * 3. **已经装过了**：独立窗口模式下 `display-mode: standalone` 为真，或者
 *    iOS 的 `navigator.standalone`。这种情况下所有安装入口都该说明结果，
 *    而不是显示一个点了没反应的按钮。
 *
 * **快照必须是稳定引用。** 订阅方是 React 的 `useSyncExternalStore`，它用
 * 引用比较判断「状态变了没有」：`getSnapshot` 每次返回新对象会让它认为永远
 * 在变，进而无限重渲染（React #185，页面直接白屏）。所以状态只存一份
 * `current`，只在值真的不同时才替换并通知。
 *
 * 事件对象不在 lib.dom 的类型里（WICG 的规范还没进标准），所以形状在下面
 * 自己声明 —— 只要那几个字段，多写一个字段就是在跟规范猜谜。
 */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * - `promptable`：拿到了可编程句柄，点按钮弹原生安装对话框。
 * - `manual`：能装，但只能由用户从浏览器界面操作 —— 具体怎么操作看
 *   `manualHint()`，iOS 是分享菜单，Chromium 拒绝过一次之后是地址栏的安装图标。
 * - `installed`：已经在独立窗口里跑。
 * - `unsupported`：这个浏览器没有任何安装途径（Firefox 桌面版就是这样）。
 */
export type InstallState = "promptable" | "manual" | "installed" | "unsupported";

export interface InstallSnapshot {
  readonly state: InstallState;
}

type Listener = () => void;

let deferred: BeforeInstallPromptEvent | null = null;
/** 见过 `beforeinstallprompt`：说明这个浏览器支持安装，只是句柄可能已用掉。 */
let supported = false;
let installed = isStandalone();

const listeners = new Set<Listener>();

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/**
 * Windows / macOS 上的 Chrome、Edge 一打开页面就会发事件，所以「不发事件」
 * 只说明这个浏览器不支持可编程安装。Safari、Firefox 属于这一类，其中 iOS
 * Safari 仍然可以手动装 —— 它不是「不能装」，只是「我们没法替你装」。
 */
function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ 自称 Mac，靠触摸点数区分。
  const ipadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return ios || ipadOs;
}

function compute(): InstallSnapshot {
  if (installed) return { state: "installed" };
  if (deferred !== null) return { state: "promptable" };
  if (supported) return { state: "manual" };
  if (isIosLike()) return { state: "manual" };
  return { state: "unsupported" };
}

/** 唯一的一份快照；`useSyncExternalStore` 拿到的引用因此在两次事件之间不变。 */
let current: InstallSnapshot = { state: "unsupported" };

function notify(): void {
  for (const listener of listeners) listener();
}

/** 重算并（只在真的变了时）通知订阅者。所有状态变化都必须走这里。 */
function refresh(): void {
  const next = compute();
  if (next.state === current.state) return;
  current = next;
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // 拦住默认行为：Chrome 自己也会在地址栏右侧放一个安装图标，但没有这次
    // preventDefault，事件不会被延迟，我们也就拿不到可编程触发的句柄。
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    supported = true;
    refresh();
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    refresh();
  });

  // 装完并打开过一次之后，`display-mode` 会变成 standalone；从独立窗口退回
  // 普通标签页时也会触发，所以两侧都要重新读，而不是只往 true 上写。
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", () => {
    installed = isStandalone();
    refresh();
  });
}

// 首次求值就把当前状态定下来：事件可能在第一个组件挂载前就发过。
current = compute();

/** 当前快照。引用稳定，可以直接交给 `useSyncExternalStore`。 */
export function installSnapshot(): InstallSnapshot {
  return current;
}

export function subscribeInstall(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `manual` 时该让用户去哪里点。两种环境的操作位置不一样，给错了比不给更糟：
 * iOS 上根本没有地址栏图标可以点，桌面 Chrome 上也没有分享菜单。
 */
export function manualHint(): "ios" | "browser" {
  return isIosLike() ? "ios" : "browser";
}

/**
 * 弹出原生安装对话框。必须在用户点击的同步调用栈里（或者紧随其后）发起，
 * 返回用户的选择；没有句柄时返回 `null`，调用方据此改走手动安装的提示。
 */
export async function requestInstall(): Promise<"accepted" | "dismissed" | null> {
  if (deferred === null) return null;
  const event = deferred;
  // 句柄只能用一次。先清掉再 await，双击也只会有一个对话框。清掉之后状态会
  // 从 `promptable` 退到 `manual`（Chrome 的地址栏图标仍然可用），所以这里
  // 必须走 refresh 而不是裸 notify。
  deferred = null;
  refresh();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return null;
  }
}

/**
 * 注册 service worker。安装资格的一部分，只在生产构建里做 —— dev 时 Vite
 * 的模块地址带 `?t=` 时间戳，缓存下来只会拿着旧模块不放。
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return;
  // 生效范围是整个源，所以放在根路径；`updateViaCache: "none"` 让浏览器每次
  // 都重新取 sw.js 本身，否则装了新版也要等浏览器自己想通。
  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .catch(() => {
      // 注册失败只影响「安装到桌面」，界面照常可用，不打扰用户。
    });
}
