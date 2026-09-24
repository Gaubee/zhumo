/**
 * Composer 触发面板内核（移植自 skill-creator-v2 composer-trigger/fuzzy，
 * 2026-09-25 前台对齐——Owner 指令「去 skill-creator-v2 那边抄」）。
 *
 * 触发符约定（v2 同款语义，按 zhumo 域映射）：
 *   `/` 命令面板（/compact 等内核命令注册表）
 *   `$` 知识库引用（分组/条目，注入引用行——agent 经 MCP 工具查阅）
 *   `@` 素材资源引用（用户资源树文件，注入 agent 可读路径行）
 *
 * [1] 检测文法：首行前缀触发 + URL 剔除（`//` 与 `://` 不激发 `/` 面板）。
 * [2] 模糊匹配：大小写不敏感子序列 + 连续段/词首加权（$ 面板检索用）。
 */

/** 触发查询（首行文法）：行以触发符开头才产生 query；URL 剔除只对 `/`。 */
export function triggerQuery(trigger: string, firstLine: string): string {
  if (!firstLine.startsWith(trigger)) return "";
  if (trigger === "/") {
    if (firstLine.startsWith("//")) return "";
    const head = firstLine.split(/\s/, 1)[0] ?? "";
    if (head.includes("://")) return "";
  }
  return firstLine;
}

/** 归一：小写 + 连字符/下划线统一为词边界空格（v2 composer-fuzzy 同法）。 */
function normalize(text: string): string {
  return text.toLowerCase().replaceAll(/[-_]+/g, " ");
}

function isWordStart(normalized: string, index: number): boolean {
  return index === 0 || normalized[index - 1] === " " || normalized[index - 1] === ".";
}

/** 子序列打分：query 字符依序出现才命中（连续 ×2、词首 ×1.5 加权）。 */
function subsequenceScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  let score = 0;
  let cursor = -1;
  let streak = 0;
  for (const char of query) {
    const found = text.indexOf(char, cursor + 1);
    if (found === -1) return null;
    streak = found === cursor + 1 ? streak + 1 : 0;
    score += 1 + (streak > 0 ? 1 : 0) + (isWordStart(text, found) ? 0.5 : 0);
    cursor = found;
  }
  return score;
}

/** 模糊匹配一条候选：name 主匹配，description 子串低权加成。 */
export function fuzzyMatch(
  query: string,
  name: string,
  description = "",
): { score: number } | null {
  const needle = normalize(query.trim());
  if (needle.length === 0) return { score: 0 };
  const base = subsequenceScore(needle, normalize(name));
  if (base === null) return null;
  const bonus = description.length > 0 && normalize(description).includes(needle) ? 0.5 : 0;
  return { score: base + bonus };
}
