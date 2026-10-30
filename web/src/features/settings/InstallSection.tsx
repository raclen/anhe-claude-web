import { useSyncExternalStore } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, useT } from "../../lib/app-state.ts";
import {
  installSnapshot,
  manualHint,
  requestInstall,
  subscribeInstall,
  type InstallSnapshot,
} from "../../lib/pwa.ts";
import { SettingsRow } from "./SettingsRow.tsx";
import styles from "./InstallSection.module.css";

/**
 * 「安装到桌面」这一行。
 *
 * 位置在设置·通用里、浏览器通知下面：两者都是关于「这个浏览器」而不是关于
 * agent 的偏好，用户会去同一个地方找。
 *
 * 三种状态各显示各的，因为它们的下一步动作完全不同：
 *
 * - `promptable` —— Chromium 给了可编程句柄，点按钮就弹原生对话框。成功与否
 *   由用户在系统对话框里决定，这里不再追一条提示（`appinstalled` 会把整行
 *   换成 `installed`）。
 * - `manual` —— 装得了，但没有可编程接口。具体点哪里由 `manualHint()` 决定：
 *   iOS 是分享菜单，桌面 Chromium（用户拒绝过一次之后）是地址栏的安装图标。
 *   这两种说法不能混用，所以文案分了两份。
 * - `installed` / `unsupported` —— 只说明结果，不给按钮：一个点了不动的按钮
 *   比没有按钮更糟。
 */
function useInstall(): InstallSnapshot {
  // 第三个参数是服务端快照，这里没有服务端渲染，给同一个稳定引用即可。
  return useSyncExternalStore(subscribeInstall, installSnapshot, installSnapshot);
}

export function InstallSection() {
  const t = useT();
  const install = useInstall();

  if (install.state === "unsupported") {
    return (
      <SettingsRow
        title={t("settings.install.title")}
        description={t("settings.install.unsupported")}
      />
    );
  }

  if (install.state === "installed") {
    return (
      <SettingsRow
        title={t("settings.install.title")}
        description={t("settings.install.installed")}
      />
    );
  }

  if (install.state === "manual") {
    return (
      <SettingsRow
        title={t("settings.install.title")}
        description={
          manualHint() === "ios"
            ? t("settings.install.manualIos")
            : t("settings.install.manualBrowser")
        }
      />
    );
  }

  return (
    <SettingsRow
      title={t("settings.install.title")}
      description={t("settings.install.description")}
    >
      <button
        type="button"
        className={styles.installButton}
        onClick={() => {
          // 必须在点击的调用栈里发起：浏览器只认用户手势。
          void requestInstall().then((outcome) => {
            if (outcome === null) {
              // 句柄在这一拍已经失效（另一个标签页装过、或浏览器收回了）。
              // 不静默失败：这行会随状态变话，用户能看到接下来该点哪里。
              actions.setNotice(t("settings.install.manualBrowser"));
            }
          });
        }}
      >
        <Glyph name="plus" size={14} />
        {t("settings.install.action")}
      </button>
    </SettingsRow>
  );
}
