/**
 * daemon 启动装配（PRODUCT_DESIGN.md §0/§8/§9；W2' 地基 + W4 内核集成）。
 * 原始需求 2026-09-23：.env → SQLite → 匿名/管理员/向导 → HTTP+oRPC-WS →
 * W4：/mcp 端点 + dsh 内核挂载（降级语义）+ 任务编排装配 + 优雅退出。
 * 正交意图：
 *   [1] 服务组装与端口监听。
 *   [2] JWT 密钥解析（缺省生成临时密钥并告警）。
 *   [3] 启动引导：匿名账号 + .env 管理员落库 + 向导种子。
 *   [4] 内核挂载链：模型路由桥 → MCP 端点 → TaskService/capabilities → kernel boot。
 *   [5] SIGINT/SIGTERM 优雅退出（会话回收 + 内核 dispose + 关库）。
 */
import { randomBytes } from 'node:crypto';
import { RPCHandler } from '@orpc/server/ws';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { ensureAnonymousUser, hashPassword } from './auth.js';
import { ANONYMOUS_USERNAME } from '@zhumo/contracts';
import type { AppConfig } from './config.js';
import { loadConfig, volatileRootWarning } from './config.js';
import { openDatabase } from './db/database.js';
import { BlobStore } from './db/blobs.js';
import { createUser, listUsers } from './db/store.js';
import { getTaskById } from './db/tasks.js';
import { DaemonHttp } from './http.js';
import { kernelDisabledByEnv, mountShufaKernel, type ShufaKernelHandle } from './kernel/boot.js';
import { createTaskSessions } from './kernel/sessions.js';
import { defaultSkillDocPath } from './kernel/prompts.js';
import path from 'node:path';
import { resolveModelRoutesFromStore, resolveShufaToolDir, TaskService } from './tasks/service.js';
import { ResourceService } from './resources.js';
import { createShufaMcpServer } from './capability/mcp.js';
import { KbStore } from './kb/store.js';
import { router, type RpcContext } from './rpc.js';
import { defaultWizardSeeds, installWizardSeeds, WizardRunner } from './wizard.js';

async function main(): Promise<void> {
  const config: AppConfig = loadConfig();
  // 走查四轮（2026-09-25）：.env 的 SHUFA_WHISPER_REPO 透传子进程——capability
  // 层 runShell 继承 process.env，管线 audio.transcribe 读它取向导选定的模型。
  if (config.fileEnv.SHUFA_WHISPER_REPO) {
    process.env.SHUFA_WHISPER_REPO = config.fileEnv.SHUFA_WHISPER_REPO;
  }
  // 走查四轮：/tmp 易失目录护栏（macOS 3 天清理 / Linux 常为 tmpfs）。
  const volatile = volatileRootWarning(config.dataRoot);
  if (volatile) console.warn(`[boot] 警告：${volatile}`);
  const db = openDatabase(config.dataRoot);
  const secret = resolveSecret(config);

  // 启动引导（幂等）：匿名账号 + .env 管理员 reconcile + 向导种子。
  ensureAnonymousUser(db);
  // 探针移交 bug（后台代理 2026-09-23）：匿名账号先建导致 listUsers 恒非空，
  // .env 管理员引导永远不触发——判定须排除匿名账号。
  if (
    config.adminUsername &&
    listUsers(db).filter((user) => user.username !== ANONYMOUS_USERNAME).length === 0
  ) {
    createUser(db, {
      username: config.adminUsername,
      passwordHash: hashPassword(config.adminPassword),
      role: 'admin',
    });
    console.log(`[boot] 已从 .env 引导管理员：${config.adminUsername}`);
  }
  const wizardContext = {
    dataRoot: config.dataRoot,
    shufaToolDir: resolveShufaToolDir(config.envFile),
  };
  const wizard = new WizardRunner(db, defaultWizardSeeds(wizardContext), {
    envFile: config.envFile,
    shufaToolDir: wizardContext.shufaToolDir,
  });
  installWizardSeeds(db, defaultWizardSeeds(wizardContext));
  await wizard.sniffAll(); // 开机被动嗅探：已装依赖直接呈现「已安装」（走查 R1）

  // 知识库（Owner 2026-09-22）：文件夹结构 + git 历史；空库落种子一次。
  const kb = new KbStore(path.join(config.dataRoot, 'knowledge'));
  if (await kb.ensureSeeded()) {
    console.log(`[boot] 知识库种子已落盘：${kb.root}（git 历史：${kb.gitAvailable() ? '启用' : '不可用（缺 git）'}）`);
  } else if (!kb.gitAvailable()) {
    console.warn('[boot] 警告：git 不可用——知识库可读写但无历史记录（安装 git 后自动启用）');
  }

  const rpcHandler = new RPCHandler<RpcContext>(router);
  const blobs = new BlobStore(config.dataRoot, db);
  const resources = new ResourceService({ config, db, blobs });
  const http = new DaemonHttp({ config, db, wizard, secret, rpcHandler, resources, blobs, kb });
  const port = await http.listen(config.port, config.host);
  console.log(
    `[boot] 朱墨 daemon 已启动：http://${config.host}:${port}（DATA_ROOT=${config.dataRoot}，webui=${config.webuiDir}）`,
  );

  // ------------------------------------------------------------- W4 内核挂载链
  let kernel: ShufaKernelHandle | null = null;
  let tasks: TaskService;
  const sessions = createTaskSessions({
    kernel: () => kernel,
    modelSelection: async (taskId: string) => {
      // 任务覆盖（五轮活动模型）优先；缺省回落默认模型/旧链首路由。
      const task = getTaskById(db, taskId);
      if (task?.model_provider && task.model_model) {
        return {
          provider: task.model_provider,
          model: task.model_model,
          ...(task.model_effort ? { effort: task.model_effort } : {}),
        };
      }
      const bundle = resolveModelRoutesFromStore(db, config);
      if (bundle.default) return bundle.default;
      const first = bundle.routes[0];
      const model = first?.models[0]?.id;
      return first && model ? { provider: first.provider, model } : null;
    },
    // W7 联调：agent turn error → 任务 failed + 状态帧（失败路径不悬挂）。
    onSessionFailure: (sessionId, reason) => tasks.markSessionFailed(sessionId, reason),
  });
  tasks = new TaskService({
    config,
    db,
    blobs,
    sessions,
    kernelMounted: () => kernel !== null,
    kb,
  });
  http.mountTasks(tasks);

  if (kernelDisabledByEnv()) {
    console.log('[boot] SHUFA_DSH_HOST=off：dsh 内核停用（tasks 端点将返回 501）');
  } else {
    const mcpToken = randomBytes(24).toString('hex');
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const mcpHandler = createMcpHandler(() => createShufaMcpServer({ capabilities: tasks.capabilities }), {
      legacy: 'stateless',
      onerror: (error: unknown) => {
        console.error(`[mcp] handler error: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    http.mountMcpEndpoint({ token: mcpToken, handle: toNodeHandler(mcpHandler) });

    const modelRoutes = resolveModelRoutesFromStore(db, config);
    console.log(
      modelRoutes.routes.length > 0
        ? `[boot] 模型路由桥：${modelRoutes.routes.length} 条路由（${modelRoutes.routes.map((route) => `${route.provider}×${route.models.length}`).join('、')}）→ $DSH_HOME settings.yaml/.credentials.yaml`
        : '[boot] 未配置模型路由（models_routes / llm_* / .env LLM_* 均为空），内核以缺省路由运行',
    );
    const mounted = await mountShufaKernel({
      dataRoot: config.dataRoot,
      mcp: { url: mcpUrl, token: mcpToken },
      modelRoutes,
      skillDocPath: defaultSkillDocPath(path.dirname(config.envFile)),
    });
    if (mounted.kernel) {
      kernel = mounted.kernel;
      sessions.attach(kernel);
      console.log(
        `[boot] dsh 内核已挂载：entries=${kernel.record.entries.length} tools=${kernel.globalToolNames().length}`,
      );
    } else {
      console.warn(`[boot] dsh 内核未挂载：${mounted.reason ?? 'unknown'}`);
    }
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[boot] 收到 ${signal}，正在优雅退出…`);
    void (async () => {
      try {
        await sessions.dispose();
        await kernel?.dispose();
      } catch (error) {
        console.error(`[boot] 内核回收异常：${error instanceof Error ? error.message : String(error)}`);
      }
      await http.stop(1000).catch((error: unknown) => console.error(`[boot] 停机异常：${String(error)}`));
      db.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function resolveSecret(config: Pick<AppConfig, 'jwtSecret'>): string {
  if (config.jwtSecret) return config.jwtSecret;
  console.warn('[boot] 警告：JWT_SECRET 为空，本次运行使用临时随机密钥（重启后已签发凭证全部失效）');
  return randomBytes(32).toString('hex');
}

void main().catch((error: unknown) => {
  console.error('[boot] 启动失败：', error);
  process.exit(1);
});
