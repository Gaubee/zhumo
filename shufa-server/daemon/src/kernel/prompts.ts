/**
 * 提示词装配（PRODUCT_DESIGN.md §6：任务目标 + 视频路径 + 步骤清单 + export 链接）。
 * 原始需求 2026-09-23（W4）：系统段（角色 + SKILL.md 注入）走 kernel preset 的
 * persona 行；任务段（本次视频/输出要求/结果链接语义）作为首条用户消息。
 * 走查/架构调整 2026-09-23：任务段路径全部相对 agent cwd（用户根目录）；
 * 工具名引用 MCP 投影名（mcp__shufa__*，无双 shufa 前缀）。
 * 正交意图：
 *   [1] 系统段：角色定位 + SKILL.md 全文注入（缺文件降级为最小说明）。
 *   [2] 任务段：视频路径 + 工作目录 + 输出要求 + 结果链接语义（相对路径口径）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 交付物定位：skills/shufa/SKILL.md（W6 交付物；已就位，只读不写）。 */
export function defaultSkillDocPath(daemonRoot: string): string {
  // node:path 拼接（Windows 反斜杠语义下 `/` 手拼虽多数 API 可容忍，仍统一走 path）。
  return path.join(daemonRoot, '..', 'skills', 'shufa', 'SKILL.md');
}

/** 系统段（persona 行 config.text）。 */
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
    '你是朱墨内的书法讲评分析助手。你通过 shufa.* 工具编排 Python 分析管线，',
    '把一段书法/作业讲评视频变成可分享的分析包。文件系统与 shell 不是本会话的能力面，',
    '一切经工具完成。摘要（summary）必须由你阅读转录与画面产物后亲自撰写——没有摘要工具。',
    '完成 export 后，把返回的 result_url（公开结果链接）转告用户。',
    '',
    skillDoc,
  ].join('\n');
}

/** 任务段输入（tasks 服务在会话创建时装配；三者均为相对 userRoot 的相对路径）。 */
export interface TaskPromptInput {
  videoPath: string;
  taskDir: string;
  workdir: string;
}

/** 任务段（首条用户消息）。路径口径：全部相对 agent cwd（用户根目录）。 */
export function buildTaskPrompt(input: TaskPromptInput): string {
  return [
    '请分析以下讲评视频并产出分析包：',
    '',
    `- 视频文件：${input.videoPath}`,
    `- 任务目录（工具只允许在该目录及其子目录内读写）：${input.taskDir}`,
    `- 管线 WORKDIR（传给每个步骤工具的 workdir 参数，各步骤共享）：${input.workdir}`,
    '',
    '所有路径均相对于当前工作目录（你的 cwd，即用户根目录）。',
    '',
    '要求：',
    '1. 按手册顺序执行 mcp__shufa__probe → mcp__shufa__sample → mcp__shufa__orient → mcp__shufa__align → mcp__shufa__bg → mcp__shufa__grid → mcp__shufa__ink → mcp__shufa__clip → mcp__shufa__transcribe；',
    '   每步检查返回的 JSON 结果再继续。transcribe 的返回值携带转录全文（transcript_text）。',
    '2. 通读 transcribe 返回的转录全文，用 mcp__shufa__summary_write 亲自撰写摘要',
    '   （topic/paragraphs/key_points；引用教师原话里的具体点评，不要复述规则模板、不要写占位内容）。',
    '   同时必须提交 labels：',
    '   为田字格写 label 时只标有把握的——转录明确点到的字对应讲解焦点格（index 见 grid/ink 返回）；',
    '   转录没提到的格不要猜字（练习页可能有多个不同生字，你看不到图片），留空即可，',
    '   导出的 warnings 会如实呈现语义覆盖度；',
    '   为每处旁注写 desc（结合转录判断这条批注在指出什么问题）。',
    '   形如 {"grids":[{"index":1,"label":"桂","note":"本格要点：左右结构莫写宽"}],',
    '        "annotations":[{"index":0,"desc":"…"}]}（note 可选，给本格讲解要点）。',
    '3. 最后调用 mcp__shufa__export 导出分析包；检查返回里的 warnings，若有语义缺失',
    '   告警且可补救（labels 漏交），补一次 summary_write 再重导；返回值里的 result_url',
    '   就是给用户的公开结果链接，结束时把该链接和一句总评转告用户。',
  ].join('\n');
}
