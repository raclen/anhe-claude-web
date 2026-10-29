import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 开发时后端（`server/src/config.ts` 的 PORT 默认值）跑在 4419，
 * 前端 Vite 跑在 5519 并把 `/api` 反代到 4419。
 *
 * 发布版没有这一层：同一个进程同时回答前端与 API，端口固定 5419。
 * 两个数字刻意分开——开发时不该占用发布版端口，否则本地装过全局包的人
 * 一跑 `pnpm dev` 就撞端口。
 */
const API_PORT = process.env.ANHE_CLAUDE_WEB_DEV_API_PORT ?? "4419";
const API_TARGET = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly: `localhost` can resolve to ::1 only, which makes
    // the dev server unreachable from tools that dial 127.0.0.1.
    host: "127.0.0.1",
    port: 5519,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              delete proxyRes.headers["content-encoding"];
            }
          });
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
    },
  },
});
