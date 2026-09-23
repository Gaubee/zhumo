/**
 * DSH headless 内核组合（PRODUCT_DESIGN.md §0；照 skill-creator-v2
 * kernel/dsh-kernel.ts 最小可行形态裁剪）。
 * 原始需求 2026-09-23（W4）：DSH_HOME=<DATA_ROOT>/dsh-home 注入；单 dsh-base
 * bundle + 官方 profile 机制；shufa preset（persona+ask-user）；dsh-mcp-client
 * 行连 daemon /mcp；模型路由桥（settings 表/.env → settings.yaml/.credentials.yaml）。
 * 正交意图：
 *   [1] bootShufaKernel：profile/cordis/preset 落盘 + boot + facts 采集。
 *   [2] 工具面收窄 patch（KERNEL_DISABLED_TOOL_ROWS disable 行）。
 *   [3] mountShufaKernel：降级语义（boot 失败 → mounted:false + reason，
 *       daemon 照常服务；不自动重试——重启 daemon 是唯一恢复入口）。
 *   [4] 有界 dispose：fiber dispose + DSH_HOME/MCP/key env 还原。
 * 偏差说明：模型路由走 settings.yaml 热面（非 reference 的 cordis.patch.yml
 *   内联 llm 行）——与 §0 steward 双层桥决策一致。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import { stringify as stringifyYaml } from 'yaml';
import {
  injectApiKeyEnv,
  syncModelRouteCredential,
  syncModelRouteSettings,
  type ShufaModelRoute,
} from './model-route.js';
import { KERNEL_DISABLED_TOOL_ROWS } from './tool-surface.js';
import { buildSystemPersona } from './prompts.js';
import { completeTransitiveMirror } from './profile-mirror.js';

/** 内核 boot facts（无 HTTP 面；供启动日志与诊断）。 */
export interface ShufaKernelBootRecord {
  entries: Array<{ id: string; name: string }>;
  activationOrder: string[];
}

export interface ShufaKernelHandle {
  ctx: Context;
  record: ShufaKernelBootRecord;
  /** 全局工具表当前名字集合（deny-list 计算与诊断用）。 */
  globalToolNames(): string[];
  /** 有界停止：fiber dispose + env 还原。幂等由调用方保证。 */
  dispose(): Promise<void>;
}

export interface ShufaKernelOptions {
  /** DATA_ROOT（DSH_HOME = <dataRoot>/dsh-home）。 */
  dataRoot: string;
  /** daemon 的 /mcp 端点（内核组合 dsh-mcp-client 行连接）。 */
  mcp?: { url: string; token: string };
  /** 模型路由（null = 未配置模型，内核以缺省路由运行）。 */
  modelRoute: ShufaModelRoute | null;
  /** skills/shufa/SKILL.md 路径（persona 注入）。 */
  skillDocPath: string;
}

/** daemon 根（src/kernel/boot.ts → ../../package.json；tsx 源码态）。 */
const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function bootShufaKernel(options: ShufaKernelOptions): Promise<ShufaKernelHandle> {
  const home = path.join(options.dataRoot, 'dsh-home');
  mkdirSync(home, { recursive: true });
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const restoreMcpUrl = stashEnv('SHUFA_MCP_URL', options.mcp?.url);
  const restoreMcpToken = stashEnv('SHUFA_MCP_TOKEN', options.mcp?.token);
  const restoreKey = options.modelRoute ? injectApiKeyEnv(options.modelRoute) : () => {};

  // 官方 profile 机制：单 dsh-base bundle。
  const profileDir = resolveProfileDir('kernel', home);
  initProfile(profileDir, ['@deepseek-ai/dsh-base'], 'startup');

  // 工具面收窄 patch：disable 通用 fs/shell/web 行（模型可见工具只能来自 shufa MCP）。
  const disableYaml = KERNEL_DISABLED_TOOL_ROWS.map((id) => `- id: ${id}\n  disabled: true\n`).join('');
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), disableYaml, 'utf8');

  // 模型路由桥（热面）：settings.yaml 路由 + .credentials.yaml version-1 refs。
  if (options.modelRoute) {
    syncModelRouteSettings(home, options.modelRoute);
    syncModelRouteCredential(home, options.modelRoute);
  }

  // shufa 产品 preset（$DSH_HOME/.agent-presets/shufa/，官方 includeUserRoot 机制）：
  // persona（系统段 + SKILL.md）+ ask-user 行，无任何通用工具行。
  const presetDir = path.join(home, '.agent-presets', 'shufa');
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(
    path.join(presetDir, 'preset.yml'),
    stringifyYaml({
      name: '朱墨分析助手',
      description: '产品会话预设——shufa.* 工具面 + ask-user，无通用 fs/shell 工具。',
      order: 1,
    }),
    'utf8',
  );
  writeFileSync(
    path.join(presetDir, 'agent.cordis.yml'),
    stringifyYaml([
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { text: buildSystemPersona(options.skillDocPath) } },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    ]),
    'utf8',
  );

  // entry rows：agent-presets roster + workspace + mcp-client（token 经 env 模板，不落盘明文）。
  const configPath = path.join(profileDir, 'cordis.yml');
  const mcpRow = options.mcp
    ? [
        '- id: mcp-shufa\n',
        "  name: '@deepseek-ai/dsh-mcp-client'\n",
        '  config:\n',
        '    serverName: shufa\n',
        '    transport: streamable-http\n',
        '    url: !!js process.env.SHUFA_MCP_URL\n',
        '    headers:\n',
        "      Authorization: !!js '`Bearer ${process.env.SHUFA_MCP_TOKEN}`'\n",
      ].join('')
    : '';
  writeFileSync(
    configPath,
    [
      '- id: agent-presets\n',
      "  name: '@deepseek-ai/dsh-agent-presets'\n",
      '  config:\n',
      '    default: shufa\n',
      '    includeShippedRoot: false\n',
      '- id: workspace\n',
      "  name: '@deepseek-ai/dsh-workspace'\n",
      mcpRow,
    ].join(''),
    'utf8',
  );

  // profile 装载 + 依赖镜像（pnpm 布局 heal 不完整的补全）。
  const installAnchor = path.join(daemonRoot, 'package.json');
  const profile = loadProfile('shufa', 'kernel', installAnchor, home);
  await healProfilesModuleFallback({ installAnchor, profile, home });
  completeTransitiveMirror(home);

  // boot：appExit 不能 process.exit（宿主进程内嵌）；激活序经 loader/entry-init 采集。
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches];
  const constructed: Array<{ options: { id: string; name: string } }> = [];
  const prepare = (ctx: Context): void => {
    ctx.provide('appExit', (code?: number) => {
      throw new Error(`kernel profile requested app exit (${code ?? 0})`);
    });
    type EntryInitContext = Context & {
      on: (event: 'loader/entry-init', listener: (entry: { options: { id: string; name: string } }) => void) => () => void;
    };
    (ctx as EntryInitContext).on('loader/entry-init', (entry) => constructed.push(entry));
  };
  const ctx = await boot('shufa', configPath, patches, prepare);

  type LoaderContext = Context & {
    loader?: { entries: () => Iterable<{ id: string; options: { name: string } }> };
  };
  const record: ShufaKernelBootRecord = {
    entries: [...((ctx as LoaderContext).loader?.entries() ?? [])].map((entry) => ({ id: entry.id, name: entry.options.name })),
    activationOrder: constructed.map((entry) => entry.options.name),
  };
  type ToolsContext = Context & { tools?: { schemas?: () => Array<{ name?: string }> } };
  const toolsRuntime = (ctx as ToolsContext).tools;
  const globalToolNames = (): string[] =>
    (toolsRuntime?.schemas?.() ?? [])
      .map((schema) => schema?.name)
      .filter((name): name is string => typeof name === 'string');

  return {
    ctx,
    record,
    globalToolNames,
    dispose: async () => {
      type FiberContext = Context & { fiber?: { dispose: () => Promise<void> } };
      await (ctx as FiberContext).fiber?.dispose();
      restoreEnv('DSH_HOME', previousDshHome);
      restoreMcpUrl();
      restoreMcpToken();
      restoreKey();
    },
  };
}

/** 降级挂载：boot 失败不阻塞 daemon（§0 dsh-host-lifecycle 实证模式）。 */
export interface ShufaKernelMount {
  mounted: boolean;
  reason?: string;
  kernel?: ShufaKernelHandle;
}

export async function mountShufaKernel(options: ShufaKernelOptions): Promise<ShufaKernelMount> {
  try {
    return { mounted: true, kernel: await bootShufaKernel(options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[kernel] dsh 内核挂载失败（daemon 降级运行）：${reason}`);
    return { mounted: false, reason };
  }
}

/** 内核挂载开关（测试/逃生口）：SHUFA_DSH_HOST=off 等效禁用。 */
export function kernelDisabledByEnv(): boolean {
  return process.env.SHUFA_DSH_HOST === 'off';
}

function stashEnv(key: string, value: string | undefined): () => void {
  const previous = process.env[key];
  if (value !== undefined) process.env[key] = value;
  return () => restoreEnv(key, previous);
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}
