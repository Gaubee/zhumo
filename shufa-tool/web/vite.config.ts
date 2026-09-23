/**
 * 意图：Vite 配置（原始需求 2026-09-22）。
 * - publicDir 指向环境变量 SHUFA_DATA 指定的分析包目录：
 *   包内 data.json → GET /data.json，assets/* → GET /assets/*。
 * - dev 端口默认 6173（CLI 传入 --port 时以 CLI 为准）。
 * - 构建护栏：缺 SHUFA_DATA 时直接失败（否则 publicDir 回退到不存在的
 *   ./public，dist 里没有 data.json，部署出去就是 404 空壳页——已发生过）。
 * 注：本文件由 Vite 以 esbuild 转译（不做类型检查），故可直接用 process.env
 * 而无需 @types/node；tsconfig 的 include 仅覆盖 src/。
 */
import { defineConfig } from "vite";

const shufaData = process.env.SHUFA_DATA;
if (!shufaData) {
  throw new Error(
    "缺少 SHUFA_DATA 环境变量：构建/开发前请指向分析包目录" +
      "（含 data.json 与 assets/）。用 shufa-serve 会自动设置。",
  );
}

export default defineConfig({
  publicDir: shufaData,
  server: {
    port: 6173,
  },
});
