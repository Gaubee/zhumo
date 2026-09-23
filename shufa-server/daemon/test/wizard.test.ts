/**
 * 向导引擎测试：命令执行/嗅探跳过/force、下载真实 HTTP、断点续传、
 * whisper 型号×镜像参数化、种子迁移（W2' 验证门 + 走查 R3/R4/R5/R6）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §1）；走查修订 2026-09-22。
 */
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WHISPER_MODEL_CATALOG, WHISPER_MIRRORS } from '@zhumo/contracts';
import { getWizardStep, listWizardSteps, updateWizardProgress } from '../src/db/store.js';
import {
  capStepLog,
  defaultWizardSeeds,
  downloadTargetPath,
  hfHubDir,
  installWizardSeeds,
  resolveWhisperUrl,
  whisperCachePartial,
  whisperCacheReady,
  WizardRunner,
} from '../src/wizard.js';
import { createServices } from './helpers.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/** 轮询等待条件为真（本 vitest 版本无 expect.waitFor）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

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
        // 走查 BUG1 后验语义：命令安装产物 + probe 验证产物 → 成功后验通过。
        command: 'echo installed-ok && touch installed.marker',
        probe: 'test -f installed.marker',
        targetDir: target,
      },
      {
        id: 'probe-fail-after',
        kind: 'command' as const,
        title: '命令成功但后验不通过',
        command: 'echo installed-ok',
        probe: 'false',
        targetDir: target,
      },
      {
        id: 'multi-log',
        kind: 'command' as const,
        title: '多行输出',
        command: 'echo alpha && echo beta && echo gamma',
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

  test('嗅探未命中 → 真实执行；成功后验通过 → done；全量日志含输出与终态行', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const view = await runner.run('probe-miss', false);
      expect(view.status).toBe('done');
      const log = view.last_log ?? '';
      // 走查 BUG1：全量日志（开始行 + 命令输出 + 终态行）不再只有最后一行。
      expect(log).toContain('开始执行…');
      expect(log).toContain('installed-ok');
      expect(log).toContain('[完成] 退出码 0');
      expect(log.indexOf('开始执行…')).toBeLessThan(log.indexOf('installed-ok'));
      expect(log.indexOf('installed-ok')).toBeLessThan(log.indexOf('[完成] 退出码 0'));
    } finally {
      s.dispose();
    }
  });

  test('BUG1 后验嗅探（失败分支）：命令退出 0 但 probe 不通过 → failed + 追加说明', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const view = await runner.run('probe-fail-after', false);
      expect(view.status).toBe('failed');
      const log = view.last_log ?? '';
      expect(log).toContain('installed-ok');
      expect(log).toContain('[完成] 退出码 0');
      expect(log).toContain(
        '命令执行成功但嗅探未通过（依赖可能未进入当前 PATH，或需重开终端），请检查后强制重试',
      );
      expect(log.indexOf('[完成] 退出码 0')).toBeLessThan(log.indexOf('命令执行成功但嗅探未通过'));
    } finally {
      s.dispose();
    }
  });

  test('BUG1 全量追加与历史保留：重跑不清空上一轮日志', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const first = await runner.run('multi-log', false);
      expect(first.status).toBe('done');
      expect(first.last_log).toContain('alpha');
      expect(first.last_log).toContain('beta');
      expect(first.last_log).toContain('gamma');

      // force 重跑：上一轮输出仍在（不许丢历史），并新增第二轮终态行。
      const second = await runner.run('multi-log', true);
      expect(second.status).toBe('done');
      const log = second.last_log ?? '';
      expect(log.split('alpha').length - 1).toBe(2); // 两轮各一条
      expect(log.split('[完成] 退出码 0').length - 1).toBe(2);
    } finally {
      s.dispose();
    }
  });

  test('BUG1 日志截断：64KB 上限截头标注（单元）与大输出落库（集成）', async () => {
    // 单元：capStepLog 截头保尾 + 标注 + 字节上限。
    const marker = '…（日志已截断）';
    const big = `${'a'.repeat(30_000)}\n${'中'.repeat(25_000)}\nTAIL-LINE`;
    const capped = capStepLog(big);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(capped.startsWith(marker)).toBe(true);
    expect(capped.endsWith('TAIL-LINE')).toBe(true);
    // 小日志原样通过。
    expect(capStepLog('hello')).toBe('hello');

    // 集成：>64KB 命令输出 → 落库日志被截断且终态行仍追加在尾。
    const s = createServices();
    try {
      const target = path.join(s.root, 'downloads');
      const seeds = [
        {
          id: 'flood',
          kind: 'command' as const,
          title: '超长输出',
          // 4000 行 ×29B ≈ 116KB > 64KB 上限（行数控制写库次数，避免测试拖慢）。
          command: 'yes flood-padding-line-0123456789 | head -n 4000',
          targetDir: target,
        },
      ];
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const view = await runner.run('flood', false);
      expect(view.status).toBe('done');
      const log = view.last_log ?? '';
      expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(log.startsWith(marker)).toBe(true);
      expect(log.endsWith('[完成] 退出码 0')).toBe(true);
    } finally {
      s.dispose();
    }
  });

  test('命令失败 → failed + 终态行入库；force 重跑嗅探命中的步骤', async () => {
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

describe('wizard 取消（走查 2026-09-24）', () => {
  test('运行中的命令步骤可取消：组杀 → 回 pending + [中断] 行，run() 正常 settle', async () => {
    const s = createServices();
    try {
      const { target } = seedsIn(s);
      const seeds = [
        {
          id: 'long-cmd',
          kind: 'command' as const,
          title: '长命令（取消面）',
          command: 'echo tick && sleep 30 && echo tock',
          targetDir: target,
        },
      ];
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const pending = runner.run('long-cmd', true);
      // 等 running 落库（开始执行…行写出）再取消。
      await waitFor(() => getWizardStep(s.db, 'long-cmd')?.status === 'running');
      await expect(runner.cancel('long-cmd')).resolves.toEqual({ ok: true });
      const view = await pending;
      expect(view.status).toBe('pending');
      expect(view.last_log ?? '').toContain('[中断] 用户取消');
      // 取消后互斥释放：可再次发起。
      await expect(runner.cancel('long-cmd')).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      s.dispose();
    }
  });

  test('运行中的下载可取消：abort → 回 pending，.download 残留供续传', async () => {
    const s = createServices();
    try {
      const { target } = seedsIn(s);
      // 慢速源：每 50ms 发 1KB，取消窗口充裕。
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-length': '102400' });
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 50);
        res.on('close', () => clearInterval(timer));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const seeds = [
        {
          id: 'slow-dl',
          kind: 'download' as const,
          title: '慢速下载（取消面）',
          command: null,
          url: `http://127.0.0.1:${port}/model-slow.bin`,
          targetDir: target,
        },
      ];
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const pending = runner.run('slow-dl', true);
      await waitFor(() => getWizardStep(s.db, 'slow-dl')?.status === 'running');
      // 等到有实际字节落盘再取消（保证 .download 残留非空）。
      const tmp = `${path.join(target, 'model-slow.bin')}.download`;
      await waitFor(() => existsSync(tmp));
      runner.cancel('slow-dl');
      const view = await pending;
      expect(view.status).toBe('pending');
      expect(view.last_log ?? '').toContain('[中断] 用户取消');
      expect(view.last_log ?? '').toContain('可续传');
      expect(existsSync(tmp)).toBe(true);
      server.close();
    } finally {
      s.dispose();
    }
  });

  test('resumable 残差投影 + 覆盖下载（force 丢弃 .download 从头下载）', async () => {
    const s = createServices();
    try {
      const { target } = seedsIn(s);
      // 记录收到的 Range 头：首轮（残差续传）应无/有 Range，force 轮必须无 Range。
      const seenRanges: (string | undefined)[] = [];
      let hits = 0;
      const server = http.createServer((req, res) => {
        hits += 1;
        seenRanges.push(req.headers.range);
        res.writeHead(200, { 'content-length': '4096' });
        res.end(Buffer.alloc(4096));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const seeds = [
        {
          id: 'dl-resume',
          kind: 'download' as const,
          title: '覆盖下载语义',
          command: null,
          url: `http://127.0.0.1:${port}/overwrite.bin`,
          targetDir: target,
        },
      ];
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      const target2 = `${path.join(target, 'overwrite.bin')}`;

      // 首轮正常下载完成 → resumable=false。
      const done = await runner.run('dl-resume', true);
      expect(done.status).toBe('done');
      expect(done.resumable).toBe(false);
      expect(existsSync(target2)).toBe(true);

      // 人工制造 .download 残差（模拟取消/中断遗留）→ 列表投影 resumable=true。
      writeFileSync(`${target2}.download`, Buffer.alloc(1024));
      expect(runner.list().find((v) => v.id === 'dl-resume')?.resumable).toBe(true);

      // 非强制 run：嗅探只看最终文件存在 → 已 done 会直接跳过（force=false 返回原状）。
      const skipped = await runner.run('dl-resume', false);
      expect(skipped.status).toBe('done');

      // 覆盖下载（force=true）：残差被丢弃——服务端不得收到 Range 头。
      const before = hits;
      const overwritten = await runner.run('dl-resume', true);
      expect(overwritten.status).toBe('done');
      expect(overwritten.resumable).toBe(false);
      expect(hits).toBe(before + 1);
      expect(seenRanges[seenRanges.length - 1]).toBeUndefined();
      // 残差已被消费清理（覆盖下载成功后 tmp 改名落位，无 .download 残留）。
      expect(existsSync(`${target2}.download`)).toBe(false);
      server.close();
    } finally {
      s.dispose();
    }
  });

  test('cancel 未知步骤 NOT_FOUND；未运行 CONFLICT', async () => {
    const s = createServices();
    try {
      const { seeds } = seedsIn(s);
      const runner = new WizardRunner(s.db, seeds);
      installWizardSeeds(s.db, seeds);
      await expect(runner.cancel('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(runner.cancel('dl')).rejects.toMatchObject({ code: 'CONFLICT' });
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

  test('四轮：whisper 仅 darwin/arm64；默认 = 官方源 large-v3-turbo 模型页；python-env 带 transcribe extra', () => {
    const seeds = defaultWizardSeeds(ctx, 'darwin', 'arm64');
    const whisper = seeds.find((s) => s.id === 'whisper-model')!;
    const model = WHISPER_MODEL_CATALOG.find((m) => m.id === 'whisper-large-v3-turbo')!;
    expect(whisper.url).toBe(`${WHISPER_MIRRORS[0].base}/${model.repo}`);
    expect(whisper.title).toBe('whisper 转写模型（mlx · 可选型号 + 镜像源）');
    expect(whisper.targetDir).toBe(hfHubDir());
    // mlx-whisper 无 Intel/Windows/Linux 构建：其他平台不展示该步骤。
    expect(defaultWizardSeeds(ctx, 'darwin', 'x64').find((s) => s.id === 'whisper-model')).toBeUndefined();
    expect(defaultWizardSeeds(ctx, 'linux', 'arm64').find((s) => s.id === 'whisper-model')).toBeUndefined();
    expect(defaultWizardSeeds(ctx, 'win32', 'arm64').find((s) => s.id === 'whisper-model')).toBeUndefined();
    // --extra transcribe：基础 sync 不含可选依赖（反而卸掉 mlx-whisper/torch）。
    expect(seeds.find((s) => s.id === 'python-env')?.command).toContain('--extra transcribe');
    // 探测验 venv 内容而非 uv 存在性（--no-sync 快速失败），mlx 平台含 transcribe imports。
    const probe = seeds.find((s) => s.id === 'python-env')?.probe ?? '';
    expect(probe).toContain('--no-sync');
    expect(probe).toContain('huggingface_hub');
    expect(probe).toContain('mlx_whisper');
    expect(defaultWizardSeeds(ctx, 'linux', 'arm64').find((s) => s.id === 'python-env')?.probe ?? '').not.toContain('mlx_whisper');
  });
});

describe('wizard whisper 参数化（走查 R6）', () => {
  const cnBase = WHISPER_MIRRORS.find((m) => m.id === 'cn')!.base;
  const officialBase = WHISPER_MIRRORS[0].base;

  test('resolveWhisperUrl（四轮）：模型页 = ${base}/${repo}；缺省 large-v3-turbo/official', () => {
    expect(resolveWhisperUrl(null, {})).toBe(`${officialBase}/mlx-community/whisper-large-v3-turbo`);
    expect(resolveWhisperUrl(null, { model: 'whisper-tiny', mirror: 'cn' })).toBe(
      `${cnBase}/mlx-community/whisper-tiny`,
    );
    // 只给一半：另一半从行上既有 url 反推。
    expect(resolveWhisperUrl(`${cnBase}/mlx-community/whisper-small`, { model: 'whisper-tiny' })).toBe(
      `${cnBase}/mlx-community/whisper-tiny`,
    );
    expect(resolveWhisperUrl(`${officialBase}/mlx-community/whisper-base`, { mirror: 'cn' })).toBe(
      `${cnBase}/mlx-community/whisper-base`,
    );
  });

  test('run（四轮）：模型页持久化回行；嗅探按 HF 缓存；选型回写 .env SHUFA_WHISPER_REPO', async () => {
    const s = createServices();
    // HF 缓存隔离到临时目录（hfHubDir 读 HF_HOME），预置 tiny/turbo 两仓权重。
    const hfHome = mkdtempSync(path.join(tmpdir(), 'zhumo-hf-'));
    const prevHfHome = process.env.HF_HOME;
    process.env.HF_HOME = hfHome;
    const presetCache = (repo: string): void => {
      const snap = path.join(hfHome, 'hub', `models--${repo.replace(/\//g, '--')}`, 'snapshots', 'abc');
      mkdirSync(snap, { recursive: true });
      writeFileSync(path.join(snap, 'model.safetensors'), 'x');
    };
    presetCache('mlx-community/whisper-large-v3-turbo');
    presetCache('mlx-community/whisper-tiny');
    presetCache('mlx-community/whisper-base');
    presetCache('mlx-community/whisper-small');
    try {
      // 缺省（turbo/official）：与种子一致，缓存嗅探命中 → done + 选型落 .env。
      const v1 = await s.wizard.run('whisper-model', false, {
        model: 'whisper-large-v3-turbo',
        mirror: 'official',
      });
      expect(v1.url).toBe(`${officialBase}/mlx-community/whisper-large-v3-turbo`);
      expect(v1.status).toBe('done');
      expect(v1.last_log).toContain('嗅探：模型已在 HF 缓存');
      expect(readFileSync(s.config.envFile, 'utf8')).toContain(
        'SHUFA_WHISPER_REPO=mlx-community/whisper-large-v3-turbo',
      );

      // tiny/cn：URL 更新 → 复位 pending 后按新 URL 命中缓存。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending', lastLog: null });
      const v2 = await s.wizard.run('whisper-model', false, {
        model: 'whisper-tiny',
        mirror: 'cn',
      });
      expect(v2.url).toBe(`${cnBase}/mlx-community/whisper-tiny`);
      expect(v2.status).toBe('done');
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${cnBase}/mlx-community/whisper-tiny`);

      // 只换型号：镜像从行上 url 反推（保持 cn）。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending', lastLog: null });
      const v3 = await s.wizard.run('whisper-model', false, { model: 'whisper-base' });
      expect(v3.url).toBe(`${cnBase}/mlx-community/whisper-base`);

      // 已 done 的行传新参数：选择持久化（small），但早退不重跑（last_log 不变）。
      updateWizardProgress(s.db, 'whisper-model', { status: 'done', lastLog: '历史日志' });
      const v4 = await s.wizard.run('whisper-model', false, { model: 'whisper-small' });
      expect(v4.status).toBe('done');
      expect(v4.url).toBe(`${cnBase}/mlx-community/whisper-small`);
      expect(v4.last_log).toBe('历史日志');

      // 未知型号：参数层报错，行状态与 url 不被污染。
      await expect(s.wizard.run('whisper-model', true, { model: 'nope' })).rejects.toThrow(
        '未知的 whisper 模型型号',
      );
      expect(getWizardStep(s.db, 'whisper-model')?.status).toBe('done');
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${cnBase}/mlx-community/whisper-small`);
    } finally {
      if (prevHfHome === undefined) delete process.env.HF_HOME;
      else process.env.HF_HOME = prevHfHome;
      s.dispose();
    }
  });

  test('whisperCacheReady/Partial（四轮）：snapshots 权重 = 就绪；blobs .incomplete = 残差', () => {
    const hfHome = mkdtempSync(path.join(tmpdir(), 'zhumo-hf2-'));
    const prevHfHome = process.env.HF_HOME;
    process.env.HF_HOME = hfHome;
    try {
      const repo = 'mlx-community/whisper-tiny';
      expect(whisperCacheReady(repo)).toBe(false);
      expect(whisperCachePartial(repo)).toBe(false);
      const cacheDir = path.join(hfHome, 'hub', `models--${repo.replace(/\//g, '--')}`);
      mkdirSync(path.join(cacheDir, 'blobs'), { recursive: true });
      // 只有 .incomplete：残差（恢复下载），未就绪。
      writeFileSync(path.join(cacheDir, 'blobs', 'abc.incomplete'), 'x');
      expect(whisperCacheReady(repo)).toBe(false);
      expect(whisperCachePartial(repo)).toBe(true);
      // snapshots 出现权重：就绪（残差与否不再关心——.incomplete 会被 hf 清理）。
      const snap = path.join(cacheDir, 'snapshots', 'rev1');
      mkdirSync(snap, { recursive: true });
      writeFileSync(path.join(snap, 'model.safetensors'), 'x');
      expect(whisperCacheReady(repo)).toBe(true);

      // 悬空软链不算就绪（xet 零字节成功实证：blobs/<etag> 指向不存在的分片）。
      const broken = path.join(snap, 'weights.npz');
      rmSync(path.join(snap, 'model.safetensors'));
      symlinkSync('../../blobs/deadbeef', broken);
      expect(whisperCacheReady(repo)).toBe(false);
      // 软链指向真实 blob → 就绪（snapshots 权重常态是软链）。
      writeFileSync(path.join(cacheDir, 'blobs', 'realblob'), 'xx');
      rmSync(broken);
      symlinkSync('../../blobs/realblob', broken);
      expect(whisperCacheReady(repo)).toBe(true);
    } finally {
      if (prevHfHome === undefined) delete process.env.HF_HOME;
      else process.env.HF_HOME = prevHfHome;
    }
  });
});

describe('wizard 种子迁移（走查）', () => {
  test('webui-install 行删除；定义字段恒更新；done 行 url 不覆盖；pending 行 url 跟随', () => {
    const s = createServices();
    try {
      const ts = '2026-01-01T00:00:00.000Z';
      const cnUrl = `${WHISPER_MIRRORS.find((m) => m.id === 'cn')!.base}/mlx-community/whisper-small`;
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

      // pending 行 url 跟随种子：复位后重迁移 → 回默认官方 turbo 模型页（四轮）。
      updateWizardProgress(s.db, 'whisper-model', { status: 'pending' });
      installWizardSeeds(s.db, defaultWizardSeeds({ dataRoot: s.config.dataRoot, shufaToolDir: s.root + '/shufa-tool' }));
      const turbo = WHISPER_MODEL_CATALOG.find((m) => m.id === 'whisper-large-v3-turbo')!;
      expect(getWizardStep(s.db, 'whisper-model')?.url).toBe(`${WHISPER_MIRRORS[0].base}/${turbo.repo}`);
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

  test('BUG3 进度行原位替换：同一下载只留最新进度，历史与终态行保留', async () => {
    const s = createServices();
    try {
      const target = path.join(s.root, 'models-progress');
      const runner = new WizardRunner(s.db, dlSeeds(target));
      installWizardSeeds(s.db, dlSeeds(target));
      const view = await runner.run('dl', false);
      expect(view.status).toBe('done');
      const log = view.last_log ?? '';
      // 3MB 载荷产生多条 MB 粒度进度更新，但落库日志里进度行只保留最后一条。
      expect((log.match(/已下载 /g) ?? []).length).toBe(1);
      // 历史非进度日志保留 + 完成终态行追加在尾（含路径与体积）。
      expect(log).toContain('开始执行…');
      expect(log).toContain('下载完成：');
      expect(log.indexOf('已下载 ')).toBeLessThan(log.indexOf('下载完成：'));
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

      // 三轮语义：force=覆盖下载（丢弃残差）——续传腿必须 force=false（failed 态
      // 本就不会被 done 跳过，天然走 Range 续传）。
      const done = await runner.run('dl', false);
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
