/**
 * 能力定义层（移植 skill-creator-v2 capability/core.ts，按朱墨裁剪）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §6）：name + Zod schema + authority +
 * handler，把 shufa 分析管线暴露为 agent 工具面。
 * 正交意图：
 *   [1] CapabilityDefinition / registry 构造（重名 fail fast、闭合结果 union）。
 *   [2] registry 分发：未注册 → unsupported-capability；approved-mutation 对
 *       agent 主体一律 principal-forbidden；异常兜底为 UNAVAILABLE failed。
 * 偏差说明：去除了 reference 的 human-ui/manager-recovery 主体（朱墨只有
 *   agent 一个调用方），保留值域便于未来管理面对接。
 */
import type { ZodType } from 'zod';

/** 能力权威等级：readonly 步骤 agent 直调；proposal 写型走审批；mutation 永不对 agent 开放。 */
export type CapabilityAuthority = 'readonly' | 'proposal' | 'approved-mutation';

export type CapabilityPrincipal = 'agent' | 'human-ui';

export type CapabilityCallResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'denied'; reason: 'unsupported-capability' | 'principal-forbidden'; requestedOperation: string }
  | {
      kind: 'failed';
      code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_OPERATION' | 'UNAVAILABLE' | 'STALE';
      message: string;
    };

/** 能力定义。handler 返回闭合结果；抛出的异常由 registry 兜底。 */
export interface CapabilityDefinition {
  /** 能力名（命名空间.动词，如 `shufa.probe`；全局唯一）。 */
  readonly name: string;
  readonly description: string;
  readonly authority: CapabilityAuthority;
  readonly input: ZodType;
  readonly output?: ZodType;
  readonly handler: (input: unknown, principal: CapabilityPrincipal) => CapabilityCallResult | Promise<CapabilityCallResult>;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  authority: CapabilityAuthority;
}

export interface CapabilityRegistry {
  call(name: string, input: unknown, principal: CapabilityPrincipal): Promise<CapabilityCallResult>;
  definitionOf(name: string): CapabilityDefinition | null;
  describe(): CapabilityDescriptor[];
  names(): readonly string[];
}

function denied(reason: 'unsupported-capability' | 'principal-forbidden', operation: string): CapabilityCallResult {
  return { kind: 'denied', reason, requestedOperation: operation };
}

function failed(code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_OPERATION' | 'UNAVAILABLE' | 'STALE', message: string): CapabilityCallResult {
  return { kind: 'failed', code, message };
}

/** 构造能力 registry；重名注册视为编程错误（fail fast）。 */
export function createCapabilityRegistry(definitions: readonly CapabilityDefinition[]): CapabilityRegistry {
  const byName = new Map<string, CapabilityDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`duplicate capability registration: ${definition.name}`);
    }
    byName.set(definition.name, definition);
  }
  return {
    async call(name, input, principal) {
      const definition = byName.get(name);
      if (!definition) return denied('unsupported-capability', name);
      if (definition.authority === 'approved-mutation' && principal === 'agent') {
        return denied('principal-forbidden', name);
      }
      try {
        return await definition.handler(input, principal);
      } catch (error) {
        return failed('UNAVAILABLE', error instanceof Error ? error.message : String(error));
      }
    },
    definitionOf: (name) => byName.get(name) ?? null,
    describe: () =>
      [...byName.values()].map(({ name, description, authority }) => ({ name, description, authority })),
    names: () => [...byName.keys()],
  };
}
