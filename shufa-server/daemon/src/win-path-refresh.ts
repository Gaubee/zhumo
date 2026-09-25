/**
 * Windows PATH 快照刷新（Owner Windows 实测 2026-09-25：winget 装完 ffmpeg，
 * 新终端 `ffmpeg` 可用，daemon 向导嗅探仍失败）。
 *
 * 根因：进程的 process.env.PATH 是**启动时快照**——winget/安装器写入注册表的
 * PATH 变更（WM_SETTINGCHANGE 广播）只影响之后新开的进程，已运行的 daemon
 * 收不到；嗅探与后续 spawn 都继承这份旧快照，所以「装了但找不到」。
 *
 * 嗅探必须与运行时 spawn 同源（Owner 裁定）：两者都走 process.env.PATH——
 * 因此在 probe 前重读注册表（HKLM Machine + HKCU User 的 Path 值）合并进
 * 进程快照；刷新后嗅探通过 = 后续 spawn 同样能寻址。
 *
 * 正交意图：
 *   [1] 纯函数层：reg 输出解析（UTF-16LE/UTF-8 自适应）、%VAR% 展开、
 *       旧快照 × Machine × User 三源合并且去重（启动脚本显式注入的条目保持
 *       优先——mini start-daemon.sh 的 PATH 固化语义不受影响）。
 *   [2] 刷新入口：win32 限定，spawn reg.exe 两次；失败静默（维持旧快照，
 *       嗅探行为与刷新前一致，不引入新故障面）。
 */
import { spawn } from 'node:child_process';

/** reg query 输出 → Path 值（UTF-16LE 优先自适应；无值行返回 null）。 */
export function parseRegPathValue(stdout: string): string | null {
  // reg.exe 管道输出常为 UTF-16LE（含 BOM/密集 NUL）；已按字符串传入时
  // 上层已解码，这里只做行级解析：找 "    Path    REG_EXPAND_SZ    <值>"。
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (match) return match[1]?.trim() ?? null;
  }
  return null;
}

/** %VAR% 展开（REG_EXPAND_SZ）：已知变量替换，未知原样保留。 */
export function expandEnvVars(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const resolved = env[name] ?? env[name.toUpperCase()];
    return resolved !== undefined && resolved.length > 0 ? resolved : whole;
  });
}

/**
 * 三源合并（去重保序）：旧快照在前（启动注入优先）→ Machine → User
 * （Windows PATH 生效序为 Machine 先 User 后）。
 */
export function mergePathEntries(
  current: string,
  machine: string | null,
  user: string | null,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const segment of [current, machine ?? '', user ?? '']) {
    for (const entry of segment.split(';')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(trimmed);
    }
  }
  return parts.join(';');
}

/** reg.exe 输出 buffer 解码：UTF-16LE（BOM 或密集 NUL 特征）优先，退 UTF-8。 */
function decodeRegOutput(buffer: Buffer): string {
  const hasUtf16Bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  let nullish = 0;
  for (let i = 1; i < Math.min(buffer.length, 400); i += 2) {
    if (buffer[i] === 0) nullish += 1;
  }
  if (hasUtf16Bom || nullish > 40) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

function queryRegPath(hive: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      'query',
      hive,
      '/v',
      'Path',
    ];
    const child = spawn('reg.exe', args, { windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(parseRegPathValue(decodeRegOutput(Buffer.concat(chunks)))));
  });
}

/**
 * 刷新 process.env.PATH（win32 限定；其它平台 no-op）。
 * @returns 是否发生了合并写入（reg 读失败/值缺失时 false，快照维持）。
 */
export async function refreshWindowsPath(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const [machine, user] = await Promise.all([
    queryRegPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    queryRegPath('HKCU\\Environment'),
  ]);
  if (machine === null && user === null) return false;
  const current = process.env.PATH ?? '';
  const merged = mergePathEntries(
    current,
    machine === null ? null : expandEnvVars(machine, process.env),
    user === null ? null : expandEnvVars(user, process.env),
  );
  if (merged === current) return false;
  process.env.PATH = merged;
  return true;
}
