/**
 * 模型路由连接测试（走查五轮 · 一，对齐 skill-creator-v2 dsh-route-connection
 * 裁剪到 zhumo 三协议）：最小 completion 探测——HTTP 2xx = ok（附延迟），非 2xx/
 * 网络错误/10s 超时 = failed{detail}。密钥与错误体脱敏（key 字面量替换
 * [redacted]、截 200 字）。模块永不 throw。
 */
import type { ModelsTestInput, ModelsTestOutput } from '@zhumo/contracts';

const DEFAULT_TIMEOUT_MS = 10_000;

interface ProbeSpec {
  path: string;
  headers: (apiKey: string) => Record<string, string>;
  body: (modelId: string) => unknown;
}

/** 逐协议最小探测矩阵（与内核 wire 协议一一对应）。 */
function probeSpecFor(api: string, baseURL: string, apiKey: string, modelId: string): ProbeSpec | null {
  const base = baseURL.replace(/\/+$/, '');
  switch (api) {
    case 'anthropic-messages':
      return {
        path: `${base}/v1/messages`,
        headers: () => ({
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }),
        body: () => ({
          model: modelId,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      };
    case 'openai-completions':
      return {
        path: `${base}/chat/completions`,
        headers: () => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
        body: () => ({ model: modelId, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }),
      };
    case 'openai-responses':
      return {
        path: `${base}/responses`,
        headers: () => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
        body: () => ({ model: modelId, input: 'ping' }),
      };
    default:
      return null;
  }
}

/** 探测入口：不抛异常，一切失败折叠为 {ok:false, detail}。 */
export async function testRouteConnection(input: ModelsTestInput): Promise<ModelsTestOutput> {
  const spec = probeSpecFor(input.api, input.baseURL, input.apiKey ?? '', input.modelId);
  if (!spec) return { ok: false, detail: `协议 ${input.api} 暂不支持连接测试` };
  if (!input.apiKey || input.apiKey.length === 0) {
    return { ok: false, detail: '没有可用的 API Key（先保存或直传测试密钥）' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(spec.path, {
      method: 'POST',
      headers: spec.headers(input.apiKey),
      body: JSON.stringify(spec.body(input.modelId)),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, latencyMs: Date.now() - startedAt };
    }
    const bodyText = await response.text().catch(() => '');
    return { ok: false, detail: safeDetail(`HTTP ${response.status}: ${firstLine(bodyText)}`, input.apiKey) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /abort/i.test(message);
    return {
      ok: false,
      detail: timedOut
        ? `超时（${DEFAULT_TIMEOUT_MS / 1000}s 无响应）`
        : safeDetail(`网络错误：${message}`, input.apiKey),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 错误体治理：首行 + key 脱敏 + 截断。 */
function safeDetail(text: string, apiKey: string): string {
  let detail = firstLine(text);
  if (apiKey.length > 0) detail = detail.split(apiKey).join('[redacted]');
  return detail.slice(0, 200);
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}
