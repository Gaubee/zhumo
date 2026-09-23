/**
 * 局域网访问链接（走查 BUG3，2026-09-23）：站点域名之外，后台应列出本机各网卡
 * IPv4 与 mDNS 主机名可达的 http 链接（macOS/Windows 通用——Bonjour/mDNS 由
 * 系统各自解析 `<hostname>.local`）。
 * 正交意图：
 *   [1] 纯函数面：网卡信息 → url 列表（os 依赖注入，可测）。
 *   [2] mDNS 面：hostname 小写化 + 去既有 `.local` 后缀再拼回。
 * 去重、字典序排序；SITE_BASE_URL 不掺和（那是站点域名配置自己的展示）。
 */
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from 'node:os';

/** networkInterfaces 单条信息的最小结构面（真实 os.NetworkInterfaceInfo 的子集）。 */
export interface LanInterfaceInfo {
  address: string;
  internal: boolean;
  family: string;
}

/** os 依赖注入点（默认真实 os.networkInterfaces/hostname）。 */
export interface LanOsSource {
  interfaces: () => NodeJS.Dict<readonly LanInterfaceInfo[]>;
  hostname: () => string;
}

/**
 * 纯函数：网卡信息 → `http://<ip>:<port>` 列表。
 * 只收非 internal 的 IPv4（链路本地 fe80:: 等 IPv6 一律排除），去重 + 字典序。
 */
export function ipUrlsFromInterfaces(infos: readonly LanInterfaceInfo[], port: number): string[] {
  const urls = new Set<string>();
  for (const info of infos) {
    if (info.internal || info.family !== 'IPv4') continue;
    urls.add(`http://${info.address}:${port}`);
  }
  return [...urls].sort();
}

/** mDNS 链接：hostname 小写化；已有 `.local`（含尾点）后缀先剥掉再统一拼回。 */
export function mdnsUrlFor(hostname: string, port: number): string {
  const bare = hostname.toLowerCase().replace(/\.local\.?$/, '');
  return `http://${bare}.local:${port}`;
}

/** 汇总：网卡 IPv4 链接 + mDNS 链接，整体去重排序。 */
export function lanUrls(
  port: number,
  source: LanOsSource = { interfaces: osNetworkInterfaces, hostname: osHostname },
): string[] {
  const infos = Object.values(source.interfaces())
    .flat()
    .filter((info): info is LanInterfaceInfo => info !== undefined && info !== null);
  return [...new Set([...ipUrlsFromInterfaces(infos, port), mdnsUrlFor(source.hostname(), port)])].sort();
}
