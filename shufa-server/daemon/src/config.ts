/**
 * .env 配置加载与解析（PRODUCT_DESIGN.md §8 .env 约定、§1 安装向导进入条件）。
 * 原始需求 2026-09-23（W2'）：python-dotenv 格式兼容；读不到就用默认模板创建；
 * needs_setup 判定 = ADMIN_USERNAME/ADMIN_PASSWORD 为空。
 * 正交意图：
 *   [1] dotenv 解析（注释 / export 前缀 / 引号值；process.env 优先于 .env）。
 *   [2] 默认模板创建（.env 缺失时）。
 *   [3] AppConfig 组装（DATA_ROOT 相对 .env 目录解析；SITE_BASE_URL 默认 http://HOST:PORT）。
 *   [4] .env 键值回写（保留注释与行序；向导第 1 步落 ADMIN_* 与 JWT_SECRET 用）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  /** .env 绝对路径。 */
  envFile: string;
  /** 解析后的 .env 键值（不含 process.env 覆盖）。 */
  fileEnv: Record<string, string>;
  dataRoot: string;
  adminUsername: string;
  adminPassword: string;
  /** 为空表示未配置（运行期退化为临时随机密钥，见 daemon 启装配）。 */
  jwtSecret: string;
  siteBaseUrl: string;
  host: string;
  port: number;
  webuiDir: string;
}

export const DEFAULT_ENV_TEMPLATE = [
  '# 朱墨配置（PRODUCT_DESIGN.md §8）',
  'ADMIN_USERNAME=',
  'ADMIN_PASSWORD=',
  'JWT_SECRET=',
  'SITE_BASE_URL=',
  'LLM_PROVIDER=',
  'LLM_BASE_URL=',
  'LLM_API_KEY=',
  'LLM_MODEL=',
  'DATA_ROOT=./data',
  '# 监听地址（§8 未列，daemon 约定：默认 127.0.0.1:8217，避开 6173 分析页）',
  '#HOST=127.0.0.1',
  '#PORT=8217',
  '',
].join('\n');

/** 单行 dotenv：支持注释、export 前缀、单/双引号值。 */
export function parseDotenvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  let value = withoutExport.slice(eq + 1).trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
  }
  return [key, value];
}

export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (parsed) result[parsed[0]] = parsed[1];
  }
  return result;
}

/** .env 缺失时写默认模板（目录不存在则一并创建；只读目录下静默容忍）。 */
export function ensureEnvTemplate(envFile: string): void {
  if (existsSync(envFile)) return;
  try {
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, DEFAULT_ENV_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 无写权限（如打包只读环境）：按未配置态继续，向导步骤 1 会再报错。
  }
}

/**
 * 回写键值：既有行原位替换，缺失键追加到文件尾，注释与行序保留。
 */
export function saveEnvValues(envFile: string, updates: Record<string, string>): void {
  const raw = existsSync(envFile) ? readFileSync(envFile, 'utf8') : DEFAULT_ENV_TEMPLATE;
  const pending = { ...updates };
  const lines = raw.split(/\r?\n/).map((line) => {
    const parsed = parseDotenvLine(line);
    if (!parsed) return line;
    const [key] = parsed;
    if (!(key in pending)) return line;
    const value = pending[key];
    delete pending[key];
    return `${key}=${value}`;
  });
  for (const [key, value] of Object.entries(pending)) {
    if (!raw.endsWith('\n')) lines.push('');
    lines.push(`${key}=${value}`);
  }
  writeFileSync(envFile, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

export interface LoadConfigOptions {
  envFile?: string;
  /** 供测试注入的进程环境覆盖（默认读 process.env）。 */
  processEnv?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const processEnv = options.processEnv ?? process.env;
  const envFile = path.resolve(
    options.envFile ?? processEnv.SHUFA_ENV ?? path.join(process.cwd(), '.env'),
  );
  ensureEnvTemplate(envFile);
  const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')) : {};
  const pick = (key: string): string => processEnv[key] ?? fileEnv[key] ?? '';

  const host = pick('HOST') || '127.0.0.1';
  // 默认 8217：6173 被既有 shufa-serve 分析页服务占用（2026-09-23 实证冲突）。
  const port = Number.parseInt(pick('PORT') || '8217', 10);
  const dataRoot = path.resolve(
    path.dirname(envFile),
    pick('DATA_ROOT') || './data',
  );
  const siteBaseUrl = pick('SITE_BASE_URL') || `http://${host}:${port}`;
  // webuiDir 解析：envFile 可能放仓库根（.env）也可能放子目录（runtime/w7b.env、
  // daemon/.env）——候选按 index.html 存在性择优（实证 2026-09-23：仓库根
  // .env 走 `..` 候选会指到仓库外，前台全量 404「未找到」）；末位兜底按本模块
  // 位置上溯（webui 与 daemon 恒为兄弟包，env 文件放任意处都不丢前台）。
  const envDir = path.dirname(envFile);
  const webuiCandidates = [
    path.resolve(envDir, 'webui', 'dist'),
    path.resolve(envDir, '..', 'webui', 'dist'),
    fileURLToPath(new URL('../../webui/dist', import.meta.url)),
  ];
  const webuiDir =
    webuiCandidates.find((candidate) => existsSync(path.join(candidate, 'index.html'))) ??
    webuiCandidates[0]!;
  return {
    envFile,
    fileEnv,
    dataRoot,
    adminUsername: pick('ADMIN_USERNAME'),
    adminPassword: pick('ADMIN_PASSWORD'),
    jwtSecret: pick('JWT_SECRET'),
    siteBaseUrl,
    host,
    port: Number.isFinite(port) ? port : 8217,
    webuiDir,
  };
}

/** §1 安装向导进入条件：ADMIN_USERNAME/ADMIN_PASSWORD 任一为空。 */
export function needsSetup(config: Pick<AppConfig, 'adminUsername' | 'adminPassword'>): boolean {
  return config.adminUsername === '' || config.adminPassword === '';
}
