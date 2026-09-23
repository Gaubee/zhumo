/**
 * 测试装配：tmp DATA_ROOT + 注入 env 的隔离服务构造（W2' 测试纪律要求）。
 * 原始需求 2026-09-23。
 * 正交意图：
 *   [1] createServices：临时目录 + webui/dist 假产物 + 数据库 + 向导引擎。
 *   [2] clientFor：oRPC 路由客户端（可携带 token 模拟已登录连接）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { ensureAnonymousUser } from '../src/auth.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { BlobStore } from '../src/db/blobs.js';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import {
  defaultWizardSeeds,
  installWizardSeeds,
  WizardRunner,
  type WizardSeedInput,
} from '../src/wizard.js';
import { router, type RpcContext } from '../src/rpc.js';

export const TEST_SECRET = 'shufa-w2-test-secret';

export interface TestServices {
  root: string;
  envFile: string;
  config: AppConfig;
  db: SqliteDb;
  secret: string;
  wizard: WizardRunner;
  blobs: BlobStore;
  /** 以该服务为基础派生连接 context（可附加 token/user）。 */
  context(extra?: Partial<RpcContext>): RpcContext;
  dispose(): void;
}

export function createServices(seeds?: WizardSeedInput[]): TestServices {
  const root = mkdtempSync(path.join(tmpdir(), 'shufa-w2-'));
  // 最小 webui/dist：SPA 回退与静态托管测试的落点。
  mkdirSync(path.join(root, 'webui', 'dist'), { recursive: true });
  writeFileSync(
    path.join(root, 'webui', 'dist', 'index.html'),
    '<!doctype html><html><body>shufa-spa</body></html>',
  );
  const envFile = path.join(root, 'app', '.env');
  // 四轮起 DATA_ROOT 缺省 = OS 数据目录（共享目录！）；测试隔离须显式指回临时根。
  const config = loadConfig({ envFile, processEnv: { DATA_ROOT: path.join(root, 'app', 'data') } });
  const shufaToolDir = path.join(root, 'shufa-tool');
  mkdirSync(shufaToolDir, { recursive: true });
  writeFileSync(path.join(shufaToolDir, 'pyproject.toml'), '[project]\n', 'utf8');
  const db = openDatabase(config.dataRoot);
  ensureAnonymousUser(db);
  const wizardSeeds = seeds ?? defaultWizardSeeds({ dataRoot: config.dataRoot, shufaToolDir });
  const wizard = new WizardRunner(db, wizardSeeds, { envFile });
  installWizardSeeds(db, wizardSeeds);
  const blobs = new BlobStore(config.dataRoot, db);
  return {
    root,
    envFile,
    config,
    db,
    secret: TEST_SECRET,
    wizard,
    blobs,
    context: (extra) => ({
      config,
      db,
      secret: TEST_SECRET,
      wizard,
      blobs,
      ...extra,
    }),
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 路由级客户端：调用形状 router.auth.login(...)；业务错误抛 ORPCError。 */
export function clientFor(context: RpcContext) {
  return createRouterClient(router, { context });
}
