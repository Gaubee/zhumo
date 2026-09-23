/*
  webui 构建配置（W3 朱墨前端）。
  原始需求 [2026-09-23]：朱墨 W3——Svelte5 + shadcn-svelte 壳（安装向导/登录/
  list-detail/后台三页/结果页路由），mock 数据层先行，联调期切真 API。
  正交意图：
  1. 纯 Vite SPA（无 SvelteKit）：产物为 dist/ 静态文件，由 daemon 直接托管；
     路由用 hash（自研轻路由），SPA fallback 零配置。
  2. Tailwind v4（@tailwindcss/vite 单插件）。
*/
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      $pages: fileURLToPath(new URL("./src/pages", import.meta.url)),
    },
  },
  plugins: [tailwindcss(), svelte()],
});
