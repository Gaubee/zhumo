/**
 * Windows PATH 快照刷新纯函数测试（2026-09-25 Owner Windows 实测反馈）：
 * reg 输出解析 / %VAR% 展开 / 三源合并去重。刷新入口（reg.exe spawn）为
 * win32 运行时面，mac/linux 测试环境只测纯函数层。
 */
import { describe, expect, test } from 'vitest';
import { expandEnvVars, mergePathEntries, parseRegPathValue } from '../src/win-path-refresh.js';

describe('parseRegPathValue：reg query 输出行级解析', () => {
  test('REG_EXPAND_SZ / REG_SZ 两型取值；找不到返回 null', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      '    Path    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Windows;%SYSTEMROOT%\\WinGet\\Links',
      '',
    ].join('\r\n');
    expect(parseRegPathValue(out)).toBe(
      'C:\\Windows\\system32;C:\\Windows;%SYSTEMROOT%\\WinGet\\Links',
    );
    const sz = '\r\n    Path    REG_SZ    C:\\tools\r\n';
    expect(parseRegPathValue(sz)).toBe('C:\\tools');
    expect(parseRegPathValue('    其它    REG_SZ    x\r\n')).toBeNull();
  });
});

describe('expandEnvVars：%VAR% 展开', () => {
  test('已知变量替换（大小写不敏感）；未知原样保留', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\gaubee\\AppData\\Local' };
    expect(expandEnvVars('%LOCALAPPDATA%\\Microsoft\\WinGet\\Links', env)).toBe(
      'C:\\Users\\gaubee\\AppData\\Local\\Microsoft\\WinGet\\Links',
    );
    expect(expandEnvVars('%localappdata%\\x', env)).toBe('C:\\Users\\gaubee\\AppData\\Local\\x');
    expect(expandEnvVars('%UNKNOWN_VAR%\\bin', env)).toBe('%UNKNOWN_VAR%\\bin');
  });
});

describe('mergePathEntries：旧快照 × Machine × User 合并', () => {
  test('启动注入优先（去重保序）；Machine 先 User 后；空段忽略', () => {
    const merged = mergePathEntries(
      '/opt/homebrew/bin', // 旧快照（启动脚本注入）
      'C:\\Windows\\system32;C:\\Windows',
      'C:\\Users\\gaubee\\AppData\\Local\\Microsoft\\WinGet\\Links;;C:\\Windows\\system32',
    );
    expect(merged).toBe(
      '/opt/homebrew/bin;C:\\Windows\\system32;C:\\Windows;C:\\Users\\gaubee\\AppData\\Local\\Microsoft\\WinGet\\Links',
    );
  });

  test('大小写不敏感去重（Windows 路径语义）', () => {
    expect(mergePathEntries('C:\\Tools', 'c:\\tools', null)).toBe('C:\\Tools');
  });
});
