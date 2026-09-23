/**
 * DSH profile 装载的镜像支撑（照 skill-creator-v2 dsh-profile-support.ts 移植）。
 * 原始需求 2026-09-23（W4）：profile rows 的裸包名必须经
 * $DSH_HOME/profiles/node_modules 可解析；pnpm 布局下官方 heal 不完整。
 * 正交意图：
 *   [1] 幂等目录链接（ensureDirLink）。
 *   [2] 传递闭包补全镜像（completeTransitiveMirror，循环到不动点）。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';

/** 幂等目录符号链接：目标变化时替换，不变时保持。 */
export function ensureDirLink(link: string, target: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  if (existsSync(link) && realpathSync(link) === target) return;
  rmSync(link, { recursive: true, force: true });
  // Windows：目录符号链接需要管理员/开发者模式（SeCreateSymbolicLinkPrivilege），
  // junction 无需提权且语义等价（target 已是绝对路径，满足 junction 要求）。
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 传递闭包补全：对镜像里每个包解析其 dependencies，缺失的补 symlink，循环到不动点。 */
export function completeTransitiveMirror(home: string): void {
  const mirrorRoot = path.join(home, 'profiles', 'node_modules');
  if (!existsSync(mirrorRoot)) return;
  const manifestOf = (dir: string): { dependencies?: Record<string, string> } | null => {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
    } catch {
      return null;
    }
  };
  const listPackages = (): string[] => {
    const names: string[] = [];
    for (const scope of readdirSync(mirrorRoot)) {
      if (scope.startsWith('.') || scope === '.bin') continue;
      const scopeDir = path.join(mirrorRoot, scope);
      if (scope.startsWith('@')) {
        for (const name of readdirSync(scopeDir)) names.push(`${scope}/${name}`);
      } else {
        names.push(scope);
      }
    }
    return names;
  };
  for (let round = 0; round < 8; round += 1) {
    let linked = 0;
    for (const name of listPackages()) {
      const pkgDir = path.join(mirrorRoot, name);
      const manifest = manifestOf(pkgDir);
      const deps = { ...manifest?.dependencies };
      if (!deps) continue;
      for (const dep of Object.keys(deps)) {
        const depLink = path.join(mirrorRoot, dep);
        if (existsSync(depLink)) continue;
        try {
          const anchor = path.join(realPkgDir(pkgDir), 'package.json');
          const resolved = createRequire(anchor).resolve(`${dep}/package.json`);
          ensureDirLink(depLink, path.dirname(resolved));
          linked += 1;
        } catch {
          // optional/平台专属依赖解析失败：交给官方激活期处理。
        }
      }
    }
    if (linked === 0) return;
  }
}

/** 镜像目录可能是 symlink：解析到真实包目录再作 require 锚。 */
function realPkgDir(pkgDir: string): string {
  try {
    return realpathSync(pkgDir);
  } catch {
    return pkgDir;
  }
}
