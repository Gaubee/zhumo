/**
 * 提示词装配。架构铁律（Owner 2026-09-27「过拟合」纠偏）：任务模式的提示词
 * （讲评视频分析流程、总结模式匹配、labels 规则等）只允许存在于 SKILL.md；
 * 系统段只做通用角色定位 + 引导 AI 按 SKILL 行动；任务段只携带本次任务的
 * 实例上下文（视频路径/任务目录/WORKDIR），绝不预设任务性质、绝不内联执行指令。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 交付物定位：skills/shufa/SKILL.md（W6 交付物；已就位，只读不写）。
 * 锚定修正（2026-09-25 存量 bug）：以模块位置上溯（kernel → src → daemon →
 * shufa-server/skills）——旧实现以 envFile 所在目录为锚，SHUFA_ENV 指向
 * shufa-server/.env 的部署（mini 实况）解析到 <repo>/skills 悬空路径，
 * persona 技能注入长期降级为简短兜底。模块锚定不受 cwd/envFile 影响。
 */
export function defaultSkillDocPath(): string {
  return path.resolve(MODULE_DIR, '..', '..', '..', 'skills', 'shufa', 'SKILL.md');
}

/** 系统段（persona 行 config.text）：通用引导 + SKILL.md 全文注入。 */
export function buildSystemPersona(skillDocPath: string): string {
  let skillDoc: string;
  try {
    skillDoc = readFileSync(skillDocPath, 'utf8');
  } catch {
    skillDoc = [
      '# shufa 分析步骤手册（SKILL.md 缺失，降级说明）',
      '',
      `按顺序调用 shufa.* 工具：probe → sample → orient → align → bg → grid → ink → clip → transcribe → export。`,
      `每步 stdout 末行为一行 JSON（工具返回值即解析结果）；失败按提示补跑前置步骤。`,
    ].join('\n');
  }
  return [
    '你是朱墨产品内的助手。你的能力面是 shufa.* MCP 工具与书法领域知识库；',
    '文件系统与 shell 不是本会话的能力面，一切经工具完成。',
    '',
    '如何使用这些能力，一律参照下方注入的 shufa SKILL 手册执行：',
    '- 任务提供讲评视频素材时，按手册「分析步骤手册」驱动管线，',
    '  并完成手册「你的核心工作」的摘要、标签撰写与 export 导出。',
    '- 用户要求整理、沉淀、修正知识时，按手册「知识库管理模式」执行。',
    '- 手册未覆盖的请求，如实说明能力边界，不要臆造工具或流程。',
    '',
    skillDoc,
  ].join('\n');
}

/** 任务段输入（tasks 服务在会话创建时装配；三者均为相对 userRoot 的相对路径）。 */
export interface TaskContextInput {
  videoPath: string;
  taskDir: string;
  workdir: string;
}

/**
 * 任务段实例上下文（附在用户消息之后）。只陈述本次任务的素材事实，
 * 不定性、不给指令——执行方式由用户原话 + 系统段引导的 SKILL 手册决定。
 * 路径口径：全部相对 agent cwd（用户根目录）。
 */
export function buildTaskContext(input: TaskContextInput): string {
  return [
    '本次任务素材（所有路径均相对于当前工作目录，即你的 cwd＝用户根目录）：',
    '',
    `- 视频文件：${input.videoPath}`,
    `- 任务目录（工具只允许在该目录及其子目录内读写）：${input.taskDir}`,
    `- 管线 WORKDIR（传给每个步骤工具的 workdir 参数，各步骤共享）：${input.workdir}`,
  ].join('\n');
}
