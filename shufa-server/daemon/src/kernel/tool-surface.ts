/**
 * 内核工具面收窄（PRODUCT_DESIGN.md §6「通用 fs/shell/web 工具按 deny-list 收窄」；
 * 照 skill-creator-v2 dsh-kernel KERNEL_DISABLED_TOOL_ROWS + productToolDenyList）。
 * 原始需求 2026-09-23（W4）：产品会话工具面 = shufa.* MCP 工具 + 显式 allowlist。
 * 正交意图：
 *   [1] kernel 级 disable 行清单（cordis.patch.yml 用）。
 *   [2] agent 级 restrict deny 名单计算（setup 时应用，导出供单测）。
 */

/** dsh-base 里注册模型可见通用工具的行（cordis.patch.yml disable 整行）。 */
export const KERNEL_DISABLED_TOOL_ROWS: readonly string[] = [
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'tool-web',
  'skill-filesystem',
  'tool-skill',
];

/** agent 全局工具的显式 allowlist（MCP scoped 注册不受 restrict 影响）。 */
export const KERNEL_AGENT_TOOL_ALLOWLIST: readonly string[] = ['ask_user_question', 'todo_write'];

/**
 * 全局工具 deny 名单：allowlist 与 mcp__shufa__* 之外的继承工具一律收窄。
 * （dsh-mcp-client 注册的 scoped 工具名以 mcp__<server>__<tool> 投影。）
 */
export function productToolDenyList(globalNames: readonly string[]): string[] {
  return globalNames.filter(
    (name) => !KERNEL_AGENT_TOOL_ALLOWLIST.includes(name) && !name.startsWith('mcp__shufa__'),
  );
}
