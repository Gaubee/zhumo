/**
 * 书法领域知识库存储（Owner 2026-09-22 定案：文件夹结构 + git 历史）。
 * 形态：<DATA_ROOT>/knowledge/ 是一个 git 仓库：
 *   knowledge/<分组名>/index.md        → 分组说明（note）
 *   knowledge/<分组名>/<条目key>.md     → 条目内容（value，LLM 直读短文本）
 * 两级结构即目录树；管理员可直接在文件系统里浏览/手工编辑（改动会被下一次
 * 变更的 git commit 一并收编）。
 * 历史与溯源（Owner「毕竟要用 git」）：每次变更（后台 RPC / agent MCP 写 /
 * 种子 / 恢复）= 一个 git commit，author 绑定操作者（admin:<用户名> / agent /
 * system）。恢复到历史版 = 物化该版树 + 新 commit（历史只增不减）。
 * git 缺失降级：读写照常、历史面 available=false（部署依赖策略同 ffmpeg——
 * 向导可装，装上即启用，无需迁移）。
 * 并发：daemon 单进程内 promise 链互斥（admin 与 agent 写共享同一实例）。
 */
import { execFile as execFileCb, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { KB_SEED } from './seed.js';

const execFileAsync = promisify(execFileCb);

const NOTE_FILE = 'index.md';
const EXT = '.md';
/** 组名/键名共同约束：非空、无路径分隔符/冒号/控制符、不以点开头、限长。 */
const NAME_RE = /^[^/^:.*\u0000-\u001f][^/^:\u0000-\u001f]{0,63}$/;
const KEY_RE = /^[^/^:.*\u0000-\u001f][^/^:\u0000-\u001f]{0,127}$/;

export interface KbEntrySaved {
  group: string;
  key: string;
  value: string;
}

export interface KbGroupIndex {
  name: string;
  note: string;
  keys: string[];
}

export interface KbGroupFull extends KbGroupIndex {
  entries: Array<{ key: string; value: string }>;
}

export interface KbRevision {
  id: string;
  at: string;
  actor: string;
  summary: string;
}

export interface KbRevisionDetail {
  revision: KbRevision;
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>;
  snapshot: KbGroupFull[];
}

export class KbStore {
  private gitOk: boolean | null = null;
  /** 单写者互斥：fs+git 复合操作（写文件 → add → commit）不可交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  /** 串行执行变更类操作（读写也走链以保快照一致性代价可忽略——库极小）。 */
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- 校验与路径

  private assertGroupName(name: string): string {
    if (!NAME_RE.test(name)) {
      throw new Error(`分组名不合法：${JSON.stringify(name)}（1–64 字符，不含 / : 开头点）`);
    }
    return name;
  }

  private assertKey(key: string): string {
    if (key === 'index' || !KEY_RE.test(key)) {
      throw new Error(`条目名不合法：${JSON.stringify(key)}（1–128 字符，不含 / : 开头点；index 保留）`);
    }
    return key;
  }

  private groupDir(name: string): string {
    return path.resolve(this.root, this.assertGroupName(name));
  }

  private entryFile(group: string, key: string): string {
    return path.resolve(this.groupDir(group), `${this.assertKey(key)}${EXT}`);
  }

  // ---------------------------------------------------------------- git 基座

  private git(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', ['-C', this.root, ...args], { maxBuffer: 16 * 1024 * 1024 });
  }

  /** git 可用性（一次探测缓存；root 尚非仓库时以 init 是否成功为准）。 */
  gitAvailable(): boolean {
    if (this.gitOk === null) {
      this.gitOk = spawnSync('git', ['--version']).status === 0;
    }
    return this.gitOk;
  }

  private ensureRepo(): void {
    if (!this.gitAvailable()) return;
    if (!existsSync(path.join(this.root, '.git'))) {
      mkdirSync(this.root, { recursive: true });
      const r = spawnSync('git', ['-C', this.root, 'init']);
      if (r.status !== 0) throw new Error(`git init 失败：${(r.stderr ?? '').slice(0, 200)}`);
    }
  }

  /** 提交全部变更；无暂存差异静默跳过。author 例：admin:gaubee / agent / system。 */
  private async commitAll(actor: string, summary: string): Promise<string | null> {
    this.ensureRepo();
    if (!this.gitAvailable()) return null;
    await this.git(['add', '-A']);
    const hasChange = await this.git(['diff', '--cached', '--quiet']).then(
      () => false,
      () => true,
    );
    if (!hasChange) return null;
    const email = actor.includes(':') ? `${actor.split(':')[0]}@zhumo.local` : 'zhumo@local';
    await this.git([
      '-c',
      'user.name=朱墨',
      '-c',
      'user.email=zhumo@local',
      'commit',
      '-m',
      summary,
      `--author=${actor} <${email}>`,
    ]);
    const { stdout } = await this.git(['rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  }

  // ---------------------------------------------------------------- 读面

  groupNames(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '.git')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));
  }

  private noteOf(dir: string): string {
    const noteFile = path.join(dir, NOTE_FILE);
    return existsSync(noteFile) ? readFileSync(noteFile, 'utf8') : '';
  }

  private keysOf(dir: string): string[] {
    return readdirSync(dir)
      .filter((f) => f.endsWith(EXT) && f !== NOTE_FILE)
      .map((f) => f.slice(0, -EXT.length))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  }

  listIndex(): KbGroupIndex[] {
    return this.groupNames().map((name) => {
      const dir = path.join(this.root, name);
      return { name, note: this.noteOf(dir), keys: this.keysOf(dir) };
    });
  }

  listAll(): KbGroupFull[] {
    return this.listIndex().map((g) => ({
      ...g,
      entries: g.keys.map((key) => ({
        key,
        value: readFileSync(path.join(this.root, g.name, `${key}${EXT}`), 'utf8'),
      })),
    }));
  }

  getEntry(group: string, key: string): KbEntrySaved | null {
    const file = this.entryFile(group, key);
    if (!existsSync(file)) return null;
    return { group, key, value: readFileSync(file, 'utf8') };
  }

  // ---------------------------------------------------------------- 写面（每次一 commit）

  async upsertGroup(input: { name: string; note?: string; newName?: string }, actor: string): Promise<void> {
    await this.locked(() => {
      const dir = this.groupDir(input.name);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        if (input.note !== undefined) writeFileSync(path.join(dir, NOTE_FILE), input.note, 'utf8');
        return this.commitAll(actor, `新增分组「${input.name}」`);
      }
      const parts: string[] = [];
      let targetName = input.name;
      if (input.newName !== undefined && input.newName !== input.name) {
        this.assertGroupName(input.newName);
        const newDir = path.resolve(this.root, input.newName);
        if (existsSync(newDir)) throw new Error(`分组已存在：${input.newName}`);
        renameSync(dir, newDir);
        targetName = input.newName;
        parts.push(`改名→「${input.newName}」`);
      }
      if (input.note !== undefined) {
        writeFileSync(path.join(this.root, targetName, NOTE_FILE), input.note, 'utf8');
        parts.push('更新说明');
      }
      if (parts.length === 0) return Promise.resolve(null);
      return this.commitAll(actor, `分组「${input.name}」${parts.join('，')}`);
    });
  }

  async deleteGroup(name: string, actor: string): Promise<void> {
    await this.locked(() => {
      const dir = this.groupDir(name);
      if (!existsSync(dir)) throw new Error(`分组不存在：${name}`);
      const count = this.keysOf(dir).length;
      rmSync(dir, { recursive: true, force: true });
      return this.commitAll(actor, `删除分组「${name}」（含 ${count} 条）`);
    });
  }

  async upsertEntry(
    input: { group: string; key: string; value: string; newKey?: string },
    actor: string,
  ): Promise<void> {
    await this.locked(() => {
      const dir = this.groupDir(input.group);
      if (!existsSync(dir)) throw new Error(`分组不存在：${input.group}（先建分组再添条目）`);
      const file = this.entryFile(input.group, input.key);
      const existed = existsSync(file);
      let finalPath = file;
      if (input.newKey !== undefined && input.newKey !== input.key) {
        this.assertKey(input.newKey);
        const renamed = path.join(dir, `${input.newKey}${EXT}`);
        if (existsSync(renamed)) throw new Error(`条目已存在：${input.group}/${input.newKey}`);
        if (existed) renameSync(file, renamed);
        finalPath = renamed;
      }
      writeFileSync(finalPath, input.value, { encoding: 'utf8', mode: 0o600 });
      const keyLabel = input.newKey ?? input.key;
      return this.commitAll(
        actor,
        `${existed ? '更新' : '新增'}条目「${input.group}/${keyLabel}」`,
      );
    });
  }

  async deleteEntry(group: string, key: string, actor: string): Promise<void> {
    await this.locked(() => {
      const file = this.entryFile(group, key);
      if (!existsSync(file)) throw new Error(`条目不存在：${group}/${key}`);
      rmSync(file, { force: true });
      return this.commitAll(actor, `删除条目「${group}/${key}」`);
    });
  }

  // ---------------------------------------------------------------- 历史（git）

  async revisions(): Promise<{ available: boolean; revisions: KbRevision[] }> {
    if (!this.gitAvailable() || !existsSync(path.join(this.root, '.git'))) {
      return { available: false, revisions: [] };
    }
    const { stdout } = await this.git([
      'log',
      '-n',
      '500',
      '--format=%h%x1f%aI%x1f%an%x1f%s',
    ]);
    const revisions = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [id = '', at = '', actor = '', summary = ''] = line.split('\x1f');
        return { id, at, actor, summary };
      });
    return { available: true, revisions };
  }

  async revisionDetail(id: string): Promise<KbRevisionDetail> {
    if (!this.gitAvailable()) throw new Error('git 不可用：无法查看历史');
    // 提交元信息
    const { stdout: meta } = await this.git([
      'log',
      '-n',
      '1',
      '--format=%h%x1f%aI%x1f%an%x1f%s',
      id,
    ]);
    const [revId = '', at = '', actor = '', summary = ''] = (meta.trim().split('\n')[0] ?? '').split('\x1f');
    // 变更文件清单（首提交无父级 → 对空树比）；中文路径不转义
    const { stdout: stat } = await this.git([
      '-c',
      'core.quotepath=false',
      'show',
      id,
      '--name-status',
      '--format=',
      '--no-renames',
    ]);
    const statusMap: Record<string, 'added' | 'modified' | 'deleted'> = {
      A: 'added',
      M: 'modified',
      D: 'deleted',
    };
    const changes = stat
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^[AMD]\t/.test(line))
      .map((line) => {
        const [st = '', p = ''] = line.split('\t');
        return { path: p, status: statusMap[st] ?? 'modified' };
      });
    return { revision: { id: revId, at, actor, summary }, changes, snapshot: await this.snapshotAt(id) };
  }

  /** 某修订版的全量知识库（git archive 一次取整树 + tar 解包两进程；逐文件
   * git show 会 51×~200ms≈10s，实测不可接受）。core.quotepath 不影响 archive。 */
  private async snapshotAt(id: string): Promise<KbGroupFull[]> {
    const tmp = mkdtempSync(path.join(tmpdir(), 'kb-snap-'));
    try {
      const { stdout: tarBytes } = await this.git(['archive', '--format=tar', id]);
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-x', '-C', tmp], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`tar 解压失败（exit ${code}）`)),
        );
        child.stdin.end(tarBytes);
      });
      // 目录树即快照：一级目录=分组，index.md=说明，*.md=条目
      const groups: KbGroupFull[] = readdirSync(tmp, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, note: '', keys: [], entries: [] as Array<{ key: string; value: string }> }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      for (const group of groups) {
        const dir = path.join(tmp, group.name);
        group.note = existsSync(path.join(dir, NOTE_FILE))
          ? readFileSync(path.join(dir, NOTE_FILE), 'utf8')
          : '';
        group.entries = this.keysOf(dir).map((key) => ({
          key,
          value: readFileSync(path.join(dir, `${key}${EXT}`), 'utf8'),
        }));
        group.entries.sort((a, b) => a.key.localeCompare(b.key, 'zh'));
        group.keys = group.entries.map((e) => e.key);
      }
      return groups;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** 恢复到指定修订：物化该版文件树 → 删除多余文件 → 新 commit（历史保留）。 */
  async restore(id: string, actor: string): Promise<void> {
    await this.locked(async () => {
      if (!this.gitAvailable()) throw new Error('git 不可用：无法恢复历史版本');
      // 校验修订存在（不存在时 git show 抛错）
      await this.git(['cat-file', '-t', id]);
      const target = await this.snapshotAt(id);
      // 删除当前存在但目标没有的分组目录
      for (const name of this.groupNames()) {
        if (!target.some((g) => g.name === name)) {
          rmSync(path.join(this.root, name), { recursive: true, force: true });
        }
      }
      // 物化目标内容
      for (const g of target) {
        mkdirSync(path.join(this.root, g.name), { recursive: true });
        writeFileSync(path.join(this.root, g.name, NOTE_FILE), g.note, 'utf8');
        for (const e of g.entries) {
          writeFileSync(path.join(this.root, g.name, `${e.key}${EXT}`), e.value, {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
      }
      await this.commitAll(actor, `恢复到修订 ${id} 的版本`);
    });
  }

  // ---------------------------------------------------------------- 种子

  /** 空库落种子一次（任一分组目录已存在即跳过——手工编辑过的库永不被覆盖）。 */
  async ensureSeeded(): Promise<boolean> {
    if (this.groupNames().length > 0) return false;
    await this.locked(() => {
      mkdirSync(this.root, { recursive: true });
      for (const group of KB_SEED) {
        const dir = path.join(this.root, group.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, NOTE_FILE), group.note, 'utf8');
        for (const entry of group.entries) {
          writeFileSync(path.join(dir, `${entry.key}${EXT}`), entry.value, {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
      }
      return this.commitAll('system', `初始化知识库种子（${KB_SEED.length} 组）`);
    });
    return true;
  }
}
