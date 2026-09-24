/**
 * 知识库能力面（Owner 2026-09-22：agent 经 MCP 读写知识库）。
 * 读：kb_list（组名+key 扫描面，图书馆书架模型）/ kb_get（单条内容）。
 * 写：kb_save_group / kb_save_entry / kb_delete_group / kb_delete_entry——
 * authority='proposal'：能力层放行（registry 仅拦 approved-mutation），人行
 * 确认由 SKILL.md 的「知识库管理模式」约束（写前必须 ask_user 确认）；每次
 * 写入由 KbStore 落 git 修订（actor='agent'），后台历史全程可溯。
 * 无 containment：知识库是产品级共享面（非任务目录私有），但删除类操作在
 * 提示词层要求二次确认 + 历史可恢复兜底。
 */
import { z } from 'zod';
import type { CapabilityDefinition } from './core.js';
import type { KbStore } from '../kb/store.js';

const nameField = z.string().trim().min(1).max(64);
const keyField = z.string().trim().min(1).max(128);

export function createKnowledgeCapabilities(store: KbStore): CapabilityDefinition[] {
  const definitions: CapabilityDefinition[] = [
    {
      name: 'shufa.kb_list',
      description:
        '知识库目录：返回全部分组名、分组说明与组内条目名（不含内容）——'
        + '先扫目录再按需 kb_get，好比看书架类别与书名。写总结前必扫「总结模式」组。',
      authority: 'readonly',
      input: z.object({}),
      handler: () => ({ kind: 'ok', value: { groups: store.listIndex() } }),
    },
    {
      name: 'shufa.kb_get',
      description: '读取一条知识：分组名 + 条目名 → 内容全文。',
      authority: 'readonly',
      input: z.object({ group: nameField, key: keyField }),
      handler: (raw) => {
        const input = z.object({ group: z.string(), key: z.string() }).safeParse(raw);
        if (!input.success) return { kind: 'failed', code: 'INVALID_OPERATION', message: '参数不合法' };
        const entry = store.getEntry(input.data.group, input.data.key);
        if (!entry) {
          return {
            kind: 'failed',
            code: 'NOT_FOUND',
            message: `知识条目不存在：${input.data.group}/${input.data.key}（以 kb_list 返回为准）`,
          };
        }
        return { kind: 'ok', value: entry };
      },
    },
    {
      name: 'shufa.kb_save_entry',
      description:
        '新增/更新一条知识（value 全量替换）。仅限「知识库管理模式」且用户已确认后'
        + '调用——每次写入记入 git 历史。group 需已存在。',
      authority: 'proposal',
      input: z.object({
        group: nameField,
        key: keyField,
        value: z.string().min(1).max(20000),
      }),
      handler: async (raw) => wrap(async () => {
        const input = z
          .object({ group: z.string(), key: z.string(), value: z.string() })
          .safeParse(raw);
        if (!input.success) throw new Error('参数不合法');
        await store.upsertEntry(input.data, 'agent');
        return { written: `${input.data.group}/${input.data.key}` };
      }),
    },
    {
      name: 'shufa.kb_save_group',
      description:
        '新增分组或更新分组说明（note）。仅限「知识库管理模式」且用户已确认后调用。',
      authority: 'proposal',
      input: z.object({ name: nameField, note: z.string().max(500).optional() }),
      handler: async (raw) => wrap(async () => {
        const input = z.object({ name: z.string(), note: z.string().optional() }).safeParse(raw);
        if (!input.success) throw new Error('参数不合法');
        await store.upsertGroup(input.data, 'agent');
        return { written: input.data.name };
      }),
    },
    {
      name: 'shufa.kb_delete_entry',
      description:
        '删除一条知识（git 历史可恢复）。删除类操作必须先向用户复述将删的分组/条目并获确认。',
      authority: 'proposal',
      input: z.object({ group: nameField, key: keyField }),
      handler: async (raw) => wrap(async () => {
        const input = z.object({ group: z.string(), key: z.string() }).safeParse(raw);
        if (!input.success) throw new Error('参数不合法');
        await store.deleteEntry(input.data.group, input.data.key, 'agent');
        return { deleted: `${input.data.group}/${input.data.key}` };
      }),
    },
    {
      name: 'shufa.kb_delete_group',
      description:
        '删除整个分组及其全部条目（git 历史可恢复）。必须先向用户复述分组名与条目数并获确认。',
      authority: 'proposal',
      input: z.object({ group: nameField }),
      handler: async (raw) => wrap(async () => {
        const input = z.object({ group: z.string() }).safeParse(raw);
        if (!input.success) throw new Error('参数不合法');
        await store.deleteGroup(input.data.group, 'agent');
        return { deleted: input.data.group };
      }),
    },
  ];
  return definitions;
}

/** 业务异常 → failed 结果（与 analysis.ts 同口径）。 */
async function wrap(fn: () => Promise<unknown>): Promise<ReturnType<typeof ok> | { kind: 'failed'; code: 'INVALID_OPERATION'; message: string }> {
  try {
    return ok(await fn());
  } catch (error) {
    return {
      kind: 'failed',
      code: 'INVALID_OPERATION',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function ok(value: unknown): { kind: 'ok'; value: unknown } {
  return { kind: 'ok', value };
}
