/**
 * 提示词装配测试（架构调整 2026-09-23 相对路径口径 + MCP 工具名口径）。
 * 原始需求 2026-09-23（W4）：任务段 = 视频路径 + 工作目录 + 输出要求 + 结果链接。
 */
import { describe, expect, it } from 'vitest';
import { buildTaskPrompt } from '../src/kernel/prompts.js';

const RELATIVE_INPUT = {
  videoPath: '20260922-ab12cd34/lecture.mp4',
  taskDir: '20260922-ab12cd34/.shufa',
  workdir: '20260922-ab12cd34/.shufa/.shufa-work',
};

describe('buildTaskPrompt 相对路径口径', () => {
  it('路径相对化：含 cwd 口径句，不含「绝对路径」措辞与绝对前缀', () => {
    const prompt = buildTaskPrompt(RELATIVE_INPUT);
    expect(prompt).toContain('20260922-ab12cd34/lecture.mp4');
    expect(prompt).toContain('20260922-ab12cd34/.shufa/.shufa-work');
    expect(prompt).toContain('所有路径均相对于当前工作目录（你的 cwd，即用户根目录）');
    expect(prompt).not.toContain('绝对路径');
    expect(prompt).not.toMatch(/\/(Users|home|data|tmp)\//);
  });

  it('工具名口径：MCP 投影名（无双 shufa 前缀）', () => {
    const prompt = buildTaskPrompt(RELATIVE_INPUT);
    expect(prompt).toContain('mcp__shufa__probe');
    expect(prompt).toContain('mcp__shufa__summary_write');
    expect(prompt).toContain('mcp__shufa__export');
    expect(prompt).not.toContain('mcp__shufa__shufa');
  });
});
