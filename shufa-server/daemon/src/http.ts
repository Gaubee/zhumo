/**
 * HTTP 面：webui 静态托管 + 结果页公开路由 + Range 流式 + MCP/任务 WS 通道
 * （PRODUCT_DESIGN.md §4）。
 * 原始需求 2026-09-23（W2' / W4 / W5）：静态托管 webui/dist；/r/{public_id} 同
 * index.html；/api/results/{public_id} 公开元数据；assets Range 206；
 * W4 新增 /mcp（内核 dsh-mcp-client 回连，Bearer web token）与
 * /ws/tasks/{id}（token 鉴权 + afterSeq 回放 + live 推送）；
 * W5 新增 /api/res/{id}/raw（资源原始内容，媒体预览/下载，token 鉴权 + 归属校验）。
 * 正交意图：
 *   [1] 路由分发与 upgrade 通道（/ws/rpc → oRPC；/ws/tasks/{id} → 帧流）。
 *   [2] 公开 JSON 面：/api/bootstrap、/api/results/{public_id}。
 *   [3] 文件面：结果资产、资源原始内容与 webui 静态（Range 206 / SPA 回退 / 越界 403）。
 *   [4] /mcp 端点（Bearer 先行，handler 由启动装配注入）。
 *   [5] 生命周期：listen 端口与有界 stop。
 */
import http from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type { RPCHandler } from '@orpc/server/ws';
import type { RpcContext } from './rpc.js';
import type { AppConfig } from './config.js';
import { needsSetup } from './config.js';
import type { SqliteDb } from './db/database.js';
import { getResultByPublicId } from './db/store.js';
import { isAllowAnonymous } from './auth.js';
import type { WizardRunner } from './wizard.js';
import { AnalysisDataSchema } from '@zhumo/contracts';
import { authenticate } from './auth.js';
import type { TaskService } from './tasks/service.js';
import type { ResourceService } from './resources.js';
import { BlobStore } from './db/blobs.js';
import { getResourceById } from './db/tasks.js';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface DaemonHttpOptions {
  config: AppConfig;
  db: SqliteDb;
  wizard: WizardRunner;
  /** JWT 签名密钥（启动装配解析后的最终值）。 */
  secret: string;
  rpcHandler: RPCHandler<RpcContext>;
  /** W4 任务编排（装配后 /ws/tasks/{id} 可用）。 */
  tasks?: TaskService;
  /** W5 资源管理器（装配后 /api/res/{id}/raw 可用；BlobStore 供实体寻址）。 */
  resources?: ResourceService;
  blobs?: BlobStore;
  /** /mcp 端点（启动装配注入：web token + MCP node handler）。 */
  mcpEndpoint?: { token: string; handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> };
}

export class DaemonHttp {
  private server: http.Server | null = null;
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: DaemonHttpOptions) {}

  /** 装配任务编排（内核挂载后调用；装配前 tasks 端点 501/WS 501）。 */
  mountTasks(tasks: TaskService): void {
    this.options.tasks = tasks;
  }

  /** 装配 /mcp 端点（内核 boot 前：URL/端口已定时调用）。 */
  mountMcpEndpoint(endpoint: { token: string; handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> }): void {
    this.options.mcpEndpoint = endpoint;
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        this.server = server;
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  /** 有界停机：宽限期内未走完的连接强制断开（优雅退出用）。 */
  stop(graceMs = 1000): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const client of this.wsServer.clients) client.terminate();
        for (const socket of this.sockets) socket.destroy();
        server.closeAllConnections();
      }, graceMs);
      timer.unref();
      this.wsServer.close(() => {
        server.close(() => resolve());
      });
    });
  }

  // -------------------------------------------------------------- upgrade

  private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const taskMatch = /^\/ws\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch) {
      this.handleTaskStreamUpgrade(request, socket, head, decodeURIComponent(taskMatch[1] ?? ''), url);
      return;
    }
    if (url.pathname !== '/ws/rpc') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const { config, db, wizard, secret, rpcHandler, tasks, resources, blobs } = this.options;
    const context: RpcContext = {
      config,
      db,
      wizard,
      secret,
      token: url.searchParams.get('token') ?? undefined,
      tasks,
      resources,
      blobs,
    };
    this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
      void rpcHandler
        .upgrade(guardRpcSocket(websocket as WsWebSocket), { context })
        .catch((error: unknown) => {
          // 畸形帧只断开该连接，不打穿 daemon（skill-creator-v2 实证模式）。
          try {
            websocket.close();
          } catch {
            // 已断开
          }
          console.error(`[orpc] ws 升级失败：${errorMessage(error)}`);
        });
    });
  }

  /**
   * /ws/tasks/{id}?token=&after_seq=：帧流推送（§7）。token 鉴权 + 本人/管理员
   * 校验走 TaskService；先回放持久帧再挂 live 订阅，连接关闭即退订。
   */
  private handleTaskStreamUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    taskId: string,
    url: URL,
  ): void {
    const { db, secret, tasks } = this.options;
    if (!tasks) {
      socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
      return;
    }
    const token = url.searchParams.get('token') ?? undefined;
    void authenticate(secret, db, token)
      .then((user) => {
        if (!user) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return;
        }
        const afterSeq = Number.parseInt(url.searchParams.get('after_seq') ?? '0', 10) || 0;
        this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
          const send = (frame: unknown): void => {
            if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify(frame));
          };
          let unsubscribe = (): void => {};
          void tasks
            .openFrameStream(user, taskId, afterSeq, send)
            .then((off) => {
              unsubscribe = off;
            })
            .catch((error: unknown) => {
              send({ kind: 'status', at: Date.now(), seq: -1, text: error instanceof Error ? error.message : String(error) });
              websocket.close();
            });
          websocket.once('close', () => unsubscribe());
        });
      })
      .catch(() => {
        try {
          socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        } catch {
          // 已断开
        }
      });
  }

  // -------------------------------------------------------------- http 路由

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/mcp') {
        await this.handleMcp(request, response);
        return;
      }
      if (pathname === '/api/bootstrap') {
        this.sendBootstrap(response);
        return;
      }
      const resultMatch = /^\/api\/results\/([^/]+)(?:\/(assets\/.+))?$/.exec(pathname);
      if (resultMatch) {
        await this.handleResult(
          request,
          response,
          decodeURIComponent(resultMatch[1] ?? ''),
          resultMatch[2] ?? null,
        );
        return;
      }
      const resRawMatch = /^\/api\/res\/([^/]+)\/raw$/.exec(pathname);
      if (resRawMatch) {
        await this.handleResourceRaw(request, response, decodeURIComponent(resRawMatch[1] ?? ''), url);
        return;
      }
      if (pathname.startsWith('/api/')) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: `未知 API 路径：${pathname}` }));
        return;
      }
      // /r/{public_id}：结果页与 SPA 共用同一 index.html（页面自行解析 public_id）。
      const isSpaRoute =
        pathname === '/' || pathname === '/r' || pathname.startsWith('/r/') || !pathname.includes('.');
      const staticPath = isSpaRoute ? 'index.html' : pathname.slice(1);
      await this.sendStaticFile(request, response, staticPath);
    } catch (error) {
      console.error(`[http] 处理失败：${errorMessage(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('内部错误');
    }
  }

  /** /mcp：Bearer web token 鉴权先行；handler 由启动装配注入（kernel/mcp 装配）。 */
  private async handleMcp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const endpoint = this.options.mcpEndpoint;
    if (!endpoint) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'mcp endpoint not mounted' }));
      return;
    }
    const auth = request.headers.authorization ?? '';
    if (auth !== `Bearer ${endpoint.token}`) {
      response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    await endpoint.handle(request, response);
  }

  private sendBootstrap(response: http.ServerResponse): void {
    const { config, db } = this.options;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('site_name') as
      | { value: string }
      | undefined;
    const body = {
      needs_setup: needsSetup(config),
      allow_anonymous: isAllowAnonymous(db),
      site_name: row?.value ?? '朱墨',
    };
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  /** /api/results/{pid} 元数据 + /api/results/{pid}/assets/* 文件。 */
  private async handleResult(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    publicId: string,
    assetsSuffix: string | null,
  ): Promise<void> {
    const row = getResultByPublicId(this.options.db, publicId);
    if (!row) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: `结果不存在：${publicId}` }));
      return;
    }
    if (assetsSuffix === null) {
      const dataFile = path.join(row.bundle_path, 'data.json');
      if (!existsSync(dataFile)) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: '结果 bundle 缺少 data.json' }));
        return;
      }
      const parsed = AnalysisDataSchema.safeParse(JSON.parse(readFileSync(dataFile, 'utf8')));
      if (!parsed.success) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: '结果 data.json 与契约不符' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          public_id: row.public_id,
          title: row.title,
          created_at: row.created_at,
          data: parsed.data,
        }),
      );
      return;
    }
    const assetRel = assetsSuffix.slice('assets/'.length);
    const bundleAssets = path.join(row.bundle_path, 'assets');
    const target = path.resolve(bundleAssets, assetRel);
    // containment：`..` 前缀 + 绝对路径残余都拒绝。后者是 Windows 特有面：
    // 目标在另一盘符时 path.relative 返回绝对路径（无 `..` 前缀），
    // 不查 isAbsolute 会放行跨盘任意文件读取。
    const rel = path.relative(bundleAssets, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      response.writeHead(403).end();
      return;
    }
    await this.sendFile(request, response, target, 'no-cache');
  }

  // -------------------------------------------------------------- 文件面

  /**
   * /api/res/{id}/raw：资源原始内容（媒体预览/下载）。token（query 或 Bearer）
   * 鉴权 + 归属校验（本人或 admin）；仅文件资源；MIME 按资源名扩展名判定
   * （blob 实体以 hash 命名，不能靠实体文件名猜类型）。
   */
  private async handleResourceRaw(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    resourceId: string,
    url: URL,
  ): Promise<void> {
    const { db, secret, resources, blobs } = this.options;
    if (!resources || !blobs) {
      response.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '资源管理器未装配' }));
      return;
    }
    const token = url.searchParams.get('token') ?? bearerOf(request) ?? undefined;
    const user = await authenticate(secret, db, token).catch(() => null);
    if (!user) {
      response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '需要登录' }));
      return;
    }
    const row = getResourceById(db, resourceId);
    if (!row || row.is_dir === 1 || !row.content_hash) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: `资源不存在：${resourceId}` }));
      return;
    }
    if (row.owner_id !== user.id && user.role !== 'admin') {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '无权访问他人资源' }));
      return;
    }
    const file = blobs.pathFor(row.content_hash);
    if (!existsSync(file)) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'blob 实体已回收' }));
      return;
    }
    const type = MIME[path.extname(row.name).toLowerCase()] ?? 'application/octet-stream';
    await this.sendFile(request, response, file, 'private, no-cache', type);
  }

  /** webui/dist 静态：目录内精确命中，否则 SPA 回退 index.html。 */
  private async sendStaticFile(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    relativePath: string,
  ): Promise<void> {
    const root = path.resolve(this.options.config.webuiDir);
    const file = path.resolve(root, relativePath);
    // 同 handleResult：绝对路径残余（Windows 跨盘符）也算越界。
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && !statSync(file).isDirectory()) {
      // index.html 是 SPA 入口（引用带 hash 的资产）：必须 no-cache——否则升级后
      // 浏览器最长 1 小时跑旧 bundle（实证 2026-09-23：mini 部署冒烟全部打到
      // 旧前端，向导"点击无反应"实为旧代码）。带 hash 的资产保持长缓存。
      const cache = file === path.join(root, 'index.html') ? 'no-cache' : 'public, max-age=3600';
      await this.sendFile(request, response, file, cache);
      return;
    }
    await this.sendFile(request, response, path.join(root, 'index.html'), 'no-cache');
  }

  /** 统一文件发送：Range 206（视频 seek）、HEAD、缺失 404；typeOverride 供 hash 命名实体。 */
  private async sendFile(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    filePath: string,
    cacheControl: string,
    typeOverride?: string,
  ): Promise<void> {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到');
      return;
    }
    const size = statSync(filePath).size;
    const type = typeOverride ?? MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = parseRange(request.headers['range'], size);
    if (range === 'invalid') {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    const baseHeaders: Record<string, string | number> = {
      'content-type': type,
      'cache-control': cacheControl,
      'accept-ranges': 'bytes',
    };
    if (!range) {
      response.writeHead(200, { ...baseHeaders, 'content-length': size });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      streamRange(filePath, response, 0, size - 1);
      return;
    }
    const [start, end] = range;
    response.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    streamRange(filePath, response, start, end);
  }
}

// ---------------------------------------------------------------- helpers

/** Authorization: Bearer <token> 提取（资源 raw 端点的非 query 通道）。 */
function bearerOf(request: http.IncomingMessage): string | null {
  const auth = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() ?? null;
}

/**
 * oRPC ws 适配器对畸形帧可能抛未捕获 rejection（@orpc/server 实测行为，
 * skill-creator-v2 同款防护）：message 监听器同步异常与返回的 Promise
 * rejection 一律兜底——只断开该连接，不打穿 daemon。
 */
function guardRpcSocket(websocket: WsWebSocket): WsWebSocket {
  const wrapListener = (listener: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]): void => {
      try {
        const result = listener(...args);
        if (result instanceof Promise) {
          result.catch(() => {
            try {
              websocket.close();
            } catch {
              // 已断开
            }
          });
        }
      } catch {
        try {
          websocket.close();
        } catch {
          // 已断开
        }
      }
    };
  };
  return new Proxy(websocket, {
    get(target, property, receiver) {
      if (property === 'on' || property === 'once' || property === 'addEventListener') {
        return (event: string, listener: unknown, ...rest: unknown[]) => {
          const wrapped =
            event === 'message' && typeof listener === 'function'
              ? wrapListener(listener as (...args: unknown[]) => unknown)
              : listener;
          const register = Reflect.get(target, property, receiver) as unknown as (
            ...callArgs: unknown[]
          ) => unknown;
          return register.call(target, event, wrapped, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 解析单区间 Range 头：无=undefined；语法/越界错='invalid'；否则 [start,end] 闭区间。 */
export function parseRange(
  header: string | string[] | undefined,
  size: number,
): [number, number] | 'invalid' | undefined {
  if (!header) return undefined;
  const text = Array.isArray(header) ? (header[0] ?? '') : header;
  const match = /^bytes=(\d*)-(\d*)$/.exec(text.trim());
  if (!match) return 'invalid';
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (rawStart === '') {
    // 后缀式 bytes=-N：最后 N 字节。
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'invalid';
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return [start, end];
}

/** 按闭区间流式发送文件片段（背压感知）。 */
function streamRange(
  filePath: string,
  response: http.ServerResponse,
  start: number,
  end: number,
): void {
  const fd = openSync(filePath, 'r');
  const chunkSize = 256 * 1024;
  let position = start;
  let closed = false;
  response.on('close', () => {
    closed = true;
    try {
      closeSync(fd);
    } catch {
      // 已关闭
    }
  });
  const writeNext = (): void => {
    if (closed) return;
    if (position > end) {
      closeSync(fd);
      response.end();
      return;
    }
    const length = Math.min(chunkSize, end - position + 1);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    position += read;
    const slice = read === length ? buffer : buffer.subarray(0, read);
    if (!response.write(slice)) {
      response.once('drain', writeNext);
      return;
    }
    writeNext();
  };
  writeNext();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
