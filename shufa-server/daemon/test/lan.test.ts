/**
 * 局域网访问链接测试（走查 BUG3，2026-09-23）：纯函数面（网卡 → urls，os 依赖
 * 注入）+ mDNS 主机名拼接 + rpc admin.settings.lan 接线（requireAdmin）。
 */
import { clientFor, createServices } from './helpers.js';
import { ipUrlsFromInterfaces, lanUrls, mdnsUrlFor } from '../src/lan.js';
import { describe, expect, it } from 'vitest';

describe('lan urls 纯函数', () => {
  it('ipUrlsFromInterfaces：过滤 internal 与 IPv6、去重 + 字典序', () => {
    const urls = ipUrlsFromInterfaces(
      [
        { address: '127.0.0.1', internal: true, family: 'IPv4' },
        { address: '192.168.1.5', internal: false, family: 'IPv4' },
        { address: '192.168.1.5', internal: false, family: 'IPv4' }, // 重复网卡
        { address: 'fe80::1', internal: false, family: 'IPv6' },
        { address: '10.0.0.2', internal: false, family: 'IPv4' },
      ],
      8217,
    );
    expect(urls).toEqual(['http://10.0.0.2:8217', 'http://192.168.1.5:8217']);
  });

  it('mdnsUrlFor：小写化 + 去既有 .local 后缀（含尾点）再拼回', () => {
    expect(mdnsUrlFor('MyMac.local', 8217)).toBe('http://mymac.local:8217');
    expect(mdnsUrlFor('MyMac', 8217)).toBe('http://mymac.local:8217');
    expect(mdnsUrlFor('mybox.local.', 80)).toBe('http://mybox.local:80');
  });

  it('lanUrls：网卡 + mDNS 合并去重排序（os 依赖注入）', () => {
    const urls = lanUrls(8217, {
      interfaces: () => ({
        lo0: [{ address: '127.0.0.1', internal: true, family: 'IPv4' }],
        en0: [{ address: '192.168.1.5', internal: false, family: 'IPv4' }],
      }),
      hostname: () => 'MyMac.local',
    });
    expect(urls).toEqual(['http://192.168.1.5:8217', 'http://mymac.local:8217']);
  });
});

describe('admin.settings.lan rpc 接线', () => {
  it('admin 可取 urls（端口一致）；未认证 401', async () => {
    const s = createServices();
    try {
      const bootstrap = clientFor(s.context());
      const admin = await bootstrap.setup.createAdmin({ username: 'boss', password: 'secret66' });
      const adminClient = clientFor(s.context({ token: admin.token }));
      const { urls } = await adminClient.admin.settings.lan();
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url.startsWith('http://')).toBe(true);
        expect(url.endsWith(`:${s.config.port}`)).toBe(true);
      }
      await expect(clientFor(s.context()).admin.settings.lan()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    } finally {
      s.dispose();
    }
  });
});
