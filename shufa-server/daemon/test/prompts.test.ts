/**
 * 提示词装配测试。架构铁律（Owner 2026-09-27「过拟合」纠偏）：
 * 任务段只携带实例上下文（路径），任务模式指令只存在于 SKILL.md，
 * 系统段只做通用引导——本文件守护这三条边界不回退。
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPersona, buildTaskContext, defaultSkillDocPath } from '../src/kernel/prompts.js';

const RELATIVE_INPUT = {
  videoPath: '20260922-ab12cd34/lecture.mp4',
  taskDir: '20260922-ab12cd34/.shufa',
  workdir: '20260922-ab12cd34/.shufa/.shufa-work',
};

describe('buildTaskContext 实例上下文口径', () => {
  it('含三个相对路径与 cwd 口径说明，不含绝对前缀', () => {
    const ctx = buildTaskContext(RELATIVE_INPUT);
    expect(ctx).toContain('20260922-ab12cd34/lecture.mp4');
    expect(ctx).toContain('20260922-ab12cd34/.shufa');
    expect(ctx).toContain('20260922-ab12cd34/.shufa/.shufa-work');
    expect(ctx).toContain('相对于当前工作目录');
    expect(ctx).not.toMatch(/\/(Users|home|data|tmp)\//);
  });

  it('不含任务模式指令与工具名（防过拟合回归：任务段不得预设任务性质）', () => {
    const ctx = buildTaskContext(RELATIVE_INPUT);
    expect(ctx).not.toContain('请分析');
    expect(ctx).not.toContain('分析包');
    expect(ctx).not.toContain('讲评视频');
    expect(ctx).not.toMatch(/mcp__shufa__/);
    expect(ctx).not.toContain('kb_list');
    expect(ctx).not.toContain('知识库管理模式');
    expect(ctx).not.toMatch(/^\s*\d+[.、]/m); // 无编号执行清单
  });
});

describe('buildSystemPersona 系统段引导口径', () => {
  it('注入 SKILL.md 全文并以引导语指路，引导语不内联任务执行细节', () => {
    const persona = buildSystemPersona(defaultSkillDocPath());
    expect(persona).toContain('SKILL 手册');
    expect(persona).toContain('分析步骤手册'); // SKILL.md 全文注入生效
    expect(persona).not.toContain('请分析以下讲评视频');
    // 引导语（SKILL.md 注入前的头部）只做指路，不内联工具序列与流程指令。
    const guide = persona.split('# shufa 分析步骤手册')[0];
    expect(guide).not.toMatch(/mcp__shufa__/);
    expect(guide).not.toMatch(/^\s*\d+[.、]/m);
  });

  it('SKILL.md 缺失时降级为最小说明，不抛错', () => {
    const persona = buildSystemPersona('/nonexistent/SKILL.md');
    expect(persona).toContain('降级');
    expect(persona).toContain('probe');
  });
});
