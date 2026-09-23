import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    // 每个测试文件独立进程，杜绝 better-sqlite3 原生句柄与临时目录串扰。
    pool: 'forks',
  },
});
