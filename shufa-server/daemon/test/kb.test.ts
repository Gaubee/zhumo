/**
 * 知识库三层测试（Owner 2026-09-22：文件夹结构 + git 修订历史 + agent 写面）。
 * 覆盖：
 *   [1] KbStore：种子幂等、CRUD、改名、非法名拒绝、修订流、快照/恢复（git
 *       存在时；缺 git 的设备上历史用例自动跳过且读写不炸）。
 *   [2] capability：kb_list/kb_get 读面 + agent 主体可写（proposal 级）。
 *   [3] rpc：admin.kb.* CRUD 与权限矩阵（user 403）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { KbStore } from '../src/kb/store.js';
import { createKnowledgeCapabilities } from '../src/capability/knowledge.js';
import { createCapabilityRegistry } from '../src/capability/core.js';
import { clientFor, createServices } from './helpers.js';

let root: string;
let store: KbStore;
const hasGit = spawnSync('git', ['--version']).status === 0;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'shufa-kb-'));
  store = new KbStore(path.join(root, 'knowledge'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('种子：空库落盘一次，二次调用不再覆盖', async () => {
  const seeded = await store.ensureSeeded();
  expect(seeded).toBe(true);
  const groups = store.listAll();
  expect(groups.length).toBeGreaterThanOrEqual(5);
  const modes = groups.find((g) => g.name === '总结模式');
  expect(modes).toBeTruthy();
  expect(modes!.keys).toContain('兜底·通用讲评');
  // 手工改一条后再 ensureSeeded：不被覆盖
  await store.upsertEntry(
    { group: '总结模式', key: '兜底·通用讲评', value: '手工修改后的内容' },
    'admin:test',
  );
  expect(await store.ensureSeeded()).toBe(false);
  expect(store.getEntry('总结模式', '兜底·通用讲评')?.value).toBe('手工修改后的内容');
});

test('条目 CRUD + 非法名拒绝', async () => {
  await store.upsertGroup({ name: '测试组', note: '测试用' }, 'admin:test');
  await store.upsertEntry({ group: '测试组', key: '要领一', value: '内容一' }, 'admin:test');
  expect(store.getEntry('测试组', '要领一')?.value).toBe('内容一');
  // 更新（全量替换）
  await store.upsertEntry({ group: '测试组', key: '要领一', value: '内容二' }, 'admin:test');
  expect(store.getEntry('测试组', '要领一')?.value).toBe('内容二');
  // 改名
  await store.upsertEntry(
    { group: '测试组', key: '要领一', value: '内容二', newKey: '要领一改' },
    'admin:test',
  );
  expect(store.getEntry('测试组', '要领一')).toBeNull();
  expect(store.getEntry('测试组', '要领一改')?.value).toBe('内容二');
  // 路径穿越与保留名拒绝
  await expect(
    store.upsertEntry({ group: '../逃逸', key: 'x', value: 'v' }, 'admin:test'),
  ).rejects.toThrow();
  await expect(
    store.upsertEntry({ group: '测试组', key: '../index', value: 'v' }, 'admin:test'),
  ).rejects.toThrow();
  // 组不存在
  await expect(
    store.upsertEntry({ group: '不存在', key: 'x', value: 'v' }, 'admin:test'),
  ).rejects.toThrow(/分组不存在/);
  // 删除
  await store.deleteEntry('测试组', '要领一改', 'admin:test');
  expect(store.getEntry('测试组', '要领一改')).toBeNull();
});

test('分组改名与删除', async () => {
  await store.upsertGroup({ name: '测试组', newName: '测试组二' }, 'admin:test');
  expect(store.listIndex().map((g) => g.name)).toContain('测试组二');
  await store.deleteGroup('测试组二', 'admin:test');
  expect(store.listIndex().map((g) => g.name)).not.toContain('测试组二');
});

test('修订历史与恢复（git 存在时）', async () => {
  const revs = await store.revisions();
  if (!hasGit) {
    expect(revs.available).toBe(false);
    return;
  }
  expect(revs.available).toBe(true);
  expect(revs.revisions.length).toBeGreaterThanOrEqual(3);
  // 修订元信息与变更清单
  const newest = revs.revisions[0]!;
  const detail = await store.revisionDetail(newest.id);
  expect(detail.revision.id).toBe(newest.id);
  expect(detail.changes.length).toBeGreaterThan(0);
  expect(detail.snapshot.length).toBeGreaterThan(0);
  // 恢复到最老的种子修订：兜底条目回到种子内容；历史追加不减少
  const seed = revs.revisions[revs.revisions.length - 1]!;
  const before = revs.revisions.length;
  await store.restore(seed.id, 'admin:test');
  expect(store.getEntry('总结模式', '兜底·通用讲评')?.value).not.toBe('手工修改后的内容');
  const after = await store.revisions();
  expect(after.revisions.length).toBe(before + 1);
});

test('capability：kb_list/kb_get 读面 + agent 写面（proposal）', async () => {
  const registry = createCapabilityRegistry(createKnowledgeCapabilities(store));
  const listed = await registry.call('shufa.kb_list', {}, 'agent');
  expect(listed.kind).toBe('ok');
  const groups = (listed as { value: { groups: Array<{ name: string; keys: string[] }> } }).value.groups;
  expect(groups.some((g) => g.name === '总结模式')).toBe(true);
  const got = await registry.call('shufa.kb_get', { group: '总结模式', key: '兜底·通用讲评' }, 'agent');
  expect(got.kind).toBe('ok');
  const missing = await registry.call('shufa.kb_get', { group: '总结模式', key: '不存在' }, 'agent');
  expect(missing.kind).toBe('failed');
  // agent 可写（proposal 级对 agent 放行；人行确认由提示词约束）
  await store.upsertGroup({ name: '能力测试组', note: '' }, 'admin:test');
  const saved = await registry.call(
    'shufa.kb_save_entry',
    { group: '能力测试组', key: '新知', value: 'agent 沉淀的内容' },
    'agent',
  );
  expect(saved.kind).toBe('ok');
  expect(store.getEntry('能力测试组', '新知')?.value).toBe('agent 沉淀的内容');
  await store.deleteGroup('能力测试组', 'admin:test');
});

test('rpc：admin.kb.* CRUD 与权限（user 403 / admin 200）', async () => {
  const s = createServices();
  try {
    const kb = new KbStore(path.join(s.root, 'knowledge-rpc'));
    await kb.ensureSeeded();
    const bootstrap = clientFor(s.context({ kb }));
    const admin = await bootstrap.setup.createAdmin({
      username: 'boss',
      password: 'secret66',
      allow_anonymous: false,
    });
    const adminAuthed = clientFor(s.context({ kb, token: admin.token }));
    const { groups } = await adminAuthed.admin.kb.list();
    expect(groups.length).toBeGreaterThan(0);
    const out = await adminAuthed.admin.kb.saveEntry({
      group: groups[0]!.name,
      key: 'rpc 测试条目',
      value: '经 RPC 写入',
    });
    expect(out.groups[0]!.entries.some((e) => e.key === 'rpc 测试条目')).toBe(true);
    const revs = await adminAuthed.admin.kb.revisions();
    if (hasGit) {
      expect(revs.available).toBe(true);
      expect(revs.revisions[0]!.summary).toContain('rpc 测试条目');
      expect(revs.revisions[0]!.actor).toBe('admin:boss');
    }
    // 权限：未认证 → 401/403；普通用户 → 403
    await expect(bootstrap.admin.kb.list()).rejects.toThrow();
    const adminClient = clientFor(s.context({ kb, token: admin.token }));
    await adminClient.admin.users.create({ username: 'alice', password: 'alice-pass', role: 'user' });
    const alice = await bootstrap.auth.login({ username: 'alice', password: 'alice-pass' });
    const aliceClient = clientFor(s.context({ kb, token: alice.token }));
    await expect(aliceClient.admin.kb.list()).rejects.toThrow();

  } finally {
    s.dispose();
  }
});
