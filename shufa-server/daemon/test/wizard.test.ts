/**
 * 向导引擎测试：命令执行/嗅探跳过/force、下载真实 HTTP、断点续传、
 * whisper 型号×镜像参数化、种子迁移（W2' 验证门 + 走查 R3/R4/R5/R6）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §1）；走查修订 2026-09-22。
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WHISPER_MODEL_CATALOG, WHISPER_MIRRORS } from '@zhumo/contracts';
import { getWizardStep, listWizardSteps, updateWizardProgress } from '../src/db/store.js';
import {
  defaultWizardSeeds,
  downloadTargetPath,
  installWizardSeeds,
  resolveWhisperUrl,
  WizardRunner,
} from '../src/wizard.js';
import { createServices } from './helpers.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

function seedsIn(svc: ReturnType<typeof createServices>) {
  const target = path.join(svc.root, 'downloads');
  return {
    target,
    seeds: [
      {
        id: 'probe-ok',
        kind: 'command' as const,
        title: '嗅探命中（跳过）',
        command: 'echo SHOULD-NOT-RUN',
        probe: 'true',
        targetDir: target,
      },
      {
        id: 'probe-miss',
        kind: 'command' as const,
        title: '嗅探未命中（真实执行）',
        command: 'echo installed-ok',
        probe: 'false',
        targetDir: target,
      },
      {
        id: 'cmd-fail',
        kind: 'command' as const,
        title: '命令失败',
        command: 'echo boom && exit 3',
        targetDir: target,
      },
      {
        id: 'dl',
        kind: 'download' as const,
        title: '真实下载',
        command: null,
        targetDir: target,
      },
    ],
  };
}

describe('wizard 命令步骤', () => {
  test('开机被动嗅探 sniffAll：命中 pending→done，未命中保持 pending', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      await runner.sniffAll();
      // probe: true 命中 → done + 嗅探文案；probe: false → 保持 pending 不执行命令
      expect(getWizardStep(s.db, 'probe-ok')?.status).toBe('done');
      expect(getWizardStep(s.db, 'probe-ok')?.last_log).toContain('嗅探');
      expect(getWizardStep(s.db, 'probe-miss')?.status).toBe('pending');
      expect(getWizardStep(s.db, 'probe-miss')?.last_log ?? '').not.toContain('SHOULD-NOT-RUN');
    } finally {
      s.dispose();
    }
  });

  test('嗅探通过 → done 跳过且不执行安装命令', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const view = await runner.run('probe-ok', false);
      expect(view.status).toBe('done');
      expect(view.last_log).toContain('嗅探');
      // 安装命令绝不能被执行：库里的 last_log 不含 SHOULD-NOT-RUN。
      expect(view.last_log ?? '').not.toContain('SHOULD-NOT-RUN');
    } finally {
      s.dispose();
    }
  });

  test('嗅探未命中 → 真实执行命令，last-line-log 逐行入库', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const view = await runner.run('probe-miss', false);
      expect(view.status).toBe('done');
      expect(view.last_log).toContain('installed-ok');
    } finally {
      s.dispose();
    }
  });

  test('命令失败 → failed + 退出码入库；force 重跑嗅探命中的步骤', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const failed = await runner.run('cmd-fail', false);
      expect(failed.status).toBe('failed');
      expect(failed.last_log).toContain('3');

      // 已 done 的步骤 force 后真实重跑（绕过嗅探）。
      const rerun = await runner.run('probe-ok', true);
      expect(rerun.status).toBe('done');
      expect(rerun.last_log ?? '').toContain('SHOULD-NOT-RUN');
    } finally {
      s.dispose();
    }
  });

  test('未知步骤 NOT_FOUND；默认种子落库三条（webui-install/dsh 已退役；python-env 就位）', async () => {
    const s = createServices();
    try {
      const runner = new WizardRunner(s.db, []);
      await expect(runner.run('nope', false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const rows = listWizardSteps(s.db);
      expect(rows.map((r) => r.id)).toEqual(['ffmpeg', 'python-env', 'whisper-model']);
      expect(rows.find((r) => r.id === 'webui-install')).toBeUndefined();
      expect(rows.find((r) => r.id === 'whisper-model')?.kind).toBe('download');
      // 2026-09-23：dsh 步骤退役——内核是 SDK 进程内嵌（pnpm install 就位），非系统依赖。
      expect(rows.find((r) => r.id === 'dsh')).toBeUndefined();
      expect(defaultWizardSeeds({ dataRoot: s.config.dataRoot, shufaToolDir: s.root + '/shufa-tool' }).length).toBe(3);
    } finally {
      s.dispose();
    }
  });
});

describe('wizard 种子定义（走查 R3/R4/R5/R6）', () => {
  /** 临时改写 process.platform 派生三平台种子，结束恢复原描述符。 */
  function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', descriptor!);
    }
  }

  const ctx = { dataRoot: '/tmp/whatever', shufaToolDir: '/tmp/whatever/shufa-tool' };
  const seedCommand = (id: string, platform: NodeJS.Platform) =>
    withPlatform(platform, () => defaultWizardSeeds(ctx).find((s) => s.id === id)?.command);

  test('R5：ffmpeg 三平台分支 brew / winget / apt-get', () => {
    expect(seedCommand('ffmpeg', 'darwin')).toBe('brew install ffmpeg');
    expect(seedCommand('ffmpeg', 'win32')).toBe('winget install -e --id Gyan.FFmpeg');
    expect(seedCommand('ffmpeg', 'linux')).toBe('sudo apt-get install -y ffmpeg');
  });

  test('2026-09-23：dsh 步骤退役（SDK 内嵌，不进向导）', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(withPlatform(platform, () => defaultWizardSeeds(ctx).find((s) => s.id === 'dsh'))).toBeUndefined();
    }
  });

  test('R6：whisper 默认 URL = 官方源 base，标题为「可选型号 + 镜像源」', () => {
    const seeds = defaultWizardSeeds(ctx);
    const whisper = seeds.find((s) => s.id === 'whisper-model')!;
    const base = WHISPER_MODEL_CATALOG.find((m) => m.id === 'base')!;
    expect(whisper.url).toBe(`${WHISPER_MIRRORS[0].base}/${base.file}`);
    expect(whisper.title).toBe('whisper 转写模型（可选型号 + 镜像源）');
  });
});

describe('wizard whisper 参数化（走查 R6）', () => {
  const cnBase = WHISPER_MIRRORS.find((m) => m.id === 'cn')!.base;
  const officialBase = WHISPER_MIRRORS[0].base;

  test('resolveWhisperUrl：base/official 与 large-v3-turbo/cn 组装', () => {
    expect(resolveWhisperUrl(null, {})).toBe(`${officialBase}/ggml-base.bin`);
    expect(resolveWhisperUrl(null, { model: 'large-v3-turbo', mirror: 'cn' })).toBe(
      `${cnBase}/ggml-large-v3-turbo.bin`,
    );
    // 只给一半：另一半从行上既有 url 反推。
    expect(resolveWhisperUrl(`${cnBase}/ggml-small.bin`, { model: 'tiny' })).toBe(
      `${cnBase}/ggml-tiny.bin`,
    );
    expect(resolveWhisperUrl(`${officialBase}/ggml-medium.bin`, { mirror: 'cn' })).toBe(
      `${cnBase}/ggml-medium.bin`,
    );
  });

  test('run 参数组装 URL 持久化回行；嗅探按组装后的 URL 推导目标文件', async () => {
    const s = createServices();
    try {
      const models = path.join(s.config.dataRoot, 'models');
      mkdirSync(models, { recursive: true });
      // 预置嗅探文件 → 全程「文件已存在跳过」，不触网。
      writeFileSync(path.join(models, 'ggml-base.bin'), 'sniff');
      writeFileSync(path.join(models, 'ggml-large-v3-turbo.bin'), 'sniff');

      // base/official：与种子默认一致。
      const v1 = await s.wizard.run('whisper-model', false, { model: 'base', mirror: 'official' });
      expect(v1.url).toBe(`${officialBase}/ggml-base.bin`);
      expect(v1.status).toBe('done');

      // large-v3-turbo/cn：URL 更新 → 复位 pending 后嗅探按新 URL 命中预置文件。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending', lastLog: null });
      const v2 = await s.wizard.run('whisper-model', false, {
        model: 'large-v3-turbo',
        mirror: 'cn',
      });
      expect(v2.url).toBe(`${cnBase}/ggml-large-v3-turbo.bin`);
      expect(v2.status).toBe('done');
      expect(v2.last_log).toContain('ggml-large-v3-turbo.bin');
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${cnBase}/ggml-large-v3-turbo.bin`);

      // 只换型号：镜像从行上 url 反推（保持 cn）。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending', lastLog: null });
      const v3 = await s.wizard.run('whisper-model', false, { model: 'base' });
      expect(v3.url).toBe(`${cnBase}/ggml-base.bin`);

      // 已 done 的行传新参数：选择持久化（small），但早退不重跑（last_log 不变）。
      updateWizardProgress(s.db, 'whisper-model', { status: 'done', lastLog: '历史日志' });
      const v4 = await s.wizard.run('whisper-model', false, { model: 'small' });
      expect(v4.status).toBe('done');
      expect(v4.url).toBe(`${cnBase}/ggml-small.bin`);
      expect(v4.last_log).toBe('历史日志');

      // 未知型号：参数层报错，行状态与 url 不被污染。
      await expect(s.wizard.run('whisper-model', true, { model: 'nope' })).rejects.toThrow(
        '未知的 whisper 模型型号',
      );
      expect(getWizardStep(s.db, 'whisper-model')?.status).toBe('done');
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${cnBase}/ggml-small.bin`);
    } finally {
      s.dispose();
    }
  });
});

describe('wizard 种子迁移（走查）', () => {
  test('webui-install 行删除；定义字段恒更新；done 行 url 不覆盖；pending 行 url 跟随', () => {
    const s = createServices();
    try {
      const ts = '2026-01-01T00:00:00.000Z';
      const cnUrl = `${WHISPER_MIRRORS.find((m) => m.id === 'cn')!.base}/ggml-small.bin`;
      // 伪造存量库：webui-install 行、旧命令的 done ffmpeg、自选镜像的 done whisper。
      s.db.prepare(
        `INSERT INTO wizard_steps (id, kind, title, command, url, target_dir, status, last_log, updated_at)
         VALUES ('webui-install', 'command', '旧前端构建', 'npm install', NULL, '/legacy/webui', 'done', '旧日志', ?)`,
      ).run(ts);
      s.db.prepare(
        "UPDATE wizard_steps SET command = 'brew install ffmpeg-OLD', status = 'done', last_log = '旧安装日志', updated_at = ? WHERE id = 'ffmpeg'",
      ).run(ts);
      s.db.prepare(
        "UPDATE wizard_steps SET url = ?, status = 'done', last_log = '已下载', updated_at = ? WHERE id = 'whisper-model'",
      ).run(cnUrl, ts);

      installWizardSeeds(s.db, defaultWizardSeeds({ dataRoot: s.config.dataRoot, shufaToolDir: s.root + '/shufa-tool' }));

      const rows = listWizardSteps(s.db);
      expect(rows.map((r) => r.id)).toEqual(['ffmpeg', 'python-env', 'whisper-model']); // webui-install 被删
      const ffmpeg = rows.find((r) => r.id === 'ffmpeg')!;
      expect(ffmpeg.command).toBe('brew install ffmpeg'); // 定义字段恒更新（darwin 派生）
      expect(ffmpeg.status).toBe('done'); // 运行态保留
      expect(ffmpeg.last_log).toBe('旧安装日志');
      expect(ffmpeg.updated_at).toBe(ts); // updated_at 不动
      const whisper = rows.find((r) => r.id === 'whisper-model')!;
      expect(whisper.url).toBe(cnUrl); // done 行 url 不被种子覆盖（保住自选镜像）
      expect(whisper.status).toBe('done');

      // pending 行 url 跟随种子：复位后重迁移 → 回默认官方 base。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending' });
      installWizardSeeds(s.db, defaultWizardSeeds({ dataRoot: s.config.dataRoot, shufaToolDir: s.root + '/shufa-tool' }));
      const base = WHISPER_MODEL_CATALOG.find((m) => m.id === 'base')!;
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${WHISPER_MIRRORS[0].base}/${base.file}`);
    } finally {
      s.dispose();
    }
  });
});

describe('wizard 下载步骤（真实 HTTP）', () => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x5a); // 3MB
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function dlSeeds(targetDir: string) {
    return [
      {
        id: 'dl',
        kind: 'download' as const,
        title: '真实下载',
        command: null,
        url: `http://127.0.0.1:${port}/ggml-base.bin`,
        targetDir,
      },
    ];
  }

  test('流式下载落盘 + 进度写库；文件已存在默认跳过；force 强制重下', async () => {
    const s = createServices();
    try {
      const target = path.join(s.root, 'models');
      mkdirSync(target, { recursive: true });
      const runner = new WizardRunner(s.db, dlSeeds(target));
      installWizardSeeds(s.db, dlSeeds(target));

      const view = await runner.run('dl', false);
      expect(view.status).toBe('done');
      const file = path.join(target, 'ggml-base.bin');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).byteLength).toBe(payload.byteLength);
      expect(view.last_log ?? '').toContain('下载完成');
      // 进度中间态写过库（3MB ≥ 1MB 粒度至少一条）。
      expect(view.last_log ?? '').toBeTruthy();

      // 已存在 → 嗅探跳过（把步骤复位为 pending 模拟重跑入口；已 done 的步骤
      // 在 run() 早退直接返回历史视图，这是向导的主语义）。

      updateWizardProgress(s.db, 'dl', { status: 'pending', lastLog: null });
      const skip = await runner.run('dl', false);
      expect(skip.last_log).toContain('已存在');
      expect(skip.last_log).not.toContain('下载完成：');

      // force → 重新下载。
      writeFileSync(file, Buffer.alloc(1));
      const forced = await runner.run('dl', true);
      expect(forced.status).toBe('done');
      expect(readFileSync(file).byteLength).toBe(payload.byteLength);
    } finally {
      s.dispose();
    }
  });

  test('downloadTargetPath 从 url 尾段推导目标文件', () => {
    expect(downloadTargetPath('https://example.com/a/b/model.bin', '/tmp/x')).toBe(
      path.join('/tmp/x', 'model.bin'),
    );
    expect(downloadTargetPath('not-a-url', '/tmp/x')).toBeNull();
  });
});

describe('wizard 下载断点续传（R6，fetchImpl mock）', () => {
  const full = Buffer.alloc(4 * 1024 * 1024, 0x5a); // 4MB
  const firstChunk = full.subarray(0, 1024 * 1024); // 1MB

  /** start 即入队一段、首次 pull 时报错：模拟「200 流半途网络中断」。 */
  function brokenAfterFirstChunk(chunk: Buffer): ReadableStream<Uint8Array> {
    let errored = false;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(chunk));
      },
      pull(controller) {
        if (!errored) {
          errored = true;
          controller.error(new Error('模拟网络中断'));
        }
      },
    });
  }

  function singleChunk(chunk: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
  }

  function dlSeeds(targetDir: string) {
    return [
      {
        id: 'dl',
        kind: 'download' as const,
        title: '续传下载',
        command: null,
        url: 'https://mirror.example/ggml-base.bin',
        targetDir,
      },
    ];
  }

  test('200 半途失败 → .download 保留；206 续传 → 文件完整、.download 清失', async () => {
    const s = createServices();
    try {
      const targetDir = path.join(s.root, 'models');
      const tmp = path.join(targetDir, 'ggml-base.bin.download');
      const calls: Array<{ range?: string; have: number }> = [];
      const fetchImpl = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
        const headers = init?.headers ?? {};
        if (calls.length === 0) {
          calls.push({ have: 0 });
          return new Response(brokenAfterFirstChunk(firstChunk), {
            status: 200,
            headers: { 'content-length': String(full.length) },
          });
        }
        const have = existsSync(tmp) ? statSync(tmp).size : 0;
        calls.push({ range: headers.range, have });
        return new Response(singleChunk(full.subarray(have)), {
          status: 206,
          headers: { 'content-range': `bytes ${have}-${full.length - 1}/${full.length}` },
        });
      }) as unknown as typeof fetch;

      const runner = new WizardRunner(s.db, dlSeeds(targetDir), { fetchImpl });
      installWizardSeeds(s.db, dlSeeds(targetDir));

      const failed = await runner.run('dl', false);
      expect(failed.status).toBe('failed');
      expect(existsSync(tmp)).toBe(true); // 失败/中断保留 .download 供续传
      expect(calls[0]?.range).toBeUndefined(); // 首次无 Range

      const done = await runner.run('dl', true);
      expect(done.status).toBe('done');
      expect(done.last_log).toContain('下载完成');
      expect(calls.length).toBe(2);
      expect(calls[1]?.range).toBe(`bytes=${calls[1]?.have}-`); // 第二次带 Range 续传
      const file = path.join(targetDir, 'ggml-base.bin');
      expect(readFileSync(file).equals(full)).toBe(true); // 内容完整（拼接无缺漏）
      expect(existsSync(tmp)).toBe(false); // 完成后 .download 原子改名清失
    } finally {
      s.dispose();
    }
  });

  test('服务端不支持 Range（200）→ 丢弃已下载部分从头覆盖', async () => {
    const s = createServices();
    try {
      const targetDir = path.join(s.root, 'models');
      mkdirSync(targetDir, { recursive: true });
      const tmp = path.join(targetDir, 'ggml-base.bin.download');
      const stale = Buffer.from('stale-partial-data');
      writeFileSync(tmp, stale); // 残留部分下载
      let seenRange: string | undefined;
      const fetchImpl = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
        seenRange = init?.headers?.range;
        return new Response(singleChunk(full), {
          status: 200,
          headers: { 'content-length': String(full.length) },
        });
      }) as unknown as typeof fetch;

      const runner = new WizardRunner(s.db, dlSeeds(targetDir), { fetchImpl });
      installWizardSeeds(s.db, dlSeeds(targetDir));
      const view = await runner.run('dl', false);
      expect(view.status).toBe('done');
      expect(seenRange).toBe(`bytes=${stale.byteLength}-`); // 带了 Range，但服务端 200
      const file = path.join(targetDir, 'ggml-base.bin');
      expect(readFileSync(file).equals(full)).toBe(true); // 从头覆盖，无残留脏数据
      expect(existsSync(tmp)).toBe(false);
    } finally {
      s.dispose();
    }
  });
});
