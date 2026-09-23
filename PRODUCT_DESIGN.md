# 朱墨 产品设计 v0.2

> 命名（2026-09-23）：产品定名「朱墨」（Zhumo）——学生落墨、先生施朱；包作用域
> 同步 @shufa/* → @zhumo/*。本文档中出现的旧称「书评台」为历史名。

> 原始需求 2026-09-23：把 shufa-tool 分析管线升级为多用户 Web 产品。
> 形态：本机部署（要求用户电脑有 Python）+ 安装向导 + 后台管理 + 前台 list-detail
> + agent 编排分析工作流。前端 svelte-shadcn（与 skill-creator-v2 同栈复用）；
> agent 内核 dsh（对外不说 dsh）；SQLite 存储；WebSocket 推送。

## 0. 核心架构决策（v0.2 按 W1 研究修订）

**关键事实（skill-creator-v2 实证）**：dsh 不是 CLI spawn 集成，而是 **TS SDK**
（`@deepseek-ai/dsh-*` 全家桶 ~24 包）内嵌于 Node daemon：`bootDshKernel()` 组装
profile、`agents.create/resume` 管会话、firehose `session/event` 流式帧
（Zod 校验→统一 Frame→环形缓冲+jsonl 落盘）、工具面经 capability→MCP 投影、
模型路由桥接 `$DSH_HOME/settings.yaml`+`.credentials.yaml`。**无 iframe**（SPA
组件直渲染）。Python 无法内嵌该 SDK。

| 决策 | 选择 | 理由 |
|---|---|---|
| 应用后端 | **Node ≥24 TS daemon**（裁剪移植 skill-creator-v2 daemon 模式）：托管 webui 静态产物 + oRPC-over-WS API + SQLite（better-sqlite3）+ dsh 内核 | dsh SDK 仅 TS；最大化复用其 daemon/前端组件 |
| 分析管线 | **Python CLI（既有 shufa_tool）** 新增离散步骤子命令 `steps.py`；daemon 的 capability 层以 shell 调用 `uv run python -m shufa_tool.steps <step>` 注入给 agent | Owner 要求电脑有 py；确定性管线留 Python（未来可移植 Go/Rust） |
| agent 会话 | `agents.create/resume`（session id 存 .shufa 元数据）；DSH_HOME 指 `<data_root>/dsh-home` | Owner：会话存项目目录；恢复靠 resume 非文件重放 |
| 传输 | oRPC-over-WS + `afterSeq` 游标增量（比 skill-creator-v2 的 450ms 轮询更进一步做服务端推送） | 帧模型天然支持 |
| 模型配置 | 移植 steward 双层桥：产品真源 JSON（0600）+ 热同步 `$DSH_HOME/settings.yaml`/`.credentials.yaml` | SettingsDialog>Models 完全移植 |
| 结果页 | 现 6173 分析页编译为结果页模板，按 result public_id 独立公开访问 | Owner：结果页可独立分享 |
| 认证 | JWT（匿名开关，默认允许） | Owner 规格 |

**运行时依赖**：Node ≥24（daemon+webui）、Python + uv（分析管线）、ffmpeg、
dsh（`DSH_HOME` 注入）。

## 1. 安装向导（/setup，仅未配置时可达）

进入条件：`.env` 不存在 或 ADMIN_USERNAME/ADMIN_PASSWORD 为空。

1. **管理员账号**：用户名+密码 → 写 .env + 建库 + 落 users 表（哈希存储）。
2. **准备步骤（手风琴组）**：两类——命令安装 / 依赖下载。
   - 每项显示：标题、目标目录、来源链接、状态徽章；summary 内嵌实时预览
     （命令=last-line-log，下载=进度条）；嗅探：命令可探测（已装默认跳过）、
     下载文件已存在默认跳过；均可"强制执行"。
   - 首发步骤清单：`ffmpeg -version`（嗅探命令）、`dsh --version`（嗅探）、
     whisper 模型下载（按 OS 选 provider，显示目标目录+源链接）、
     `npm install`（仅源码分发时需要；官方分发内含预构建 webui/dist 则该步
     默认跳过——daemon 直接托管静态产物）。
3. **大模型服务配置**：移植 skill-creator-v2 `SettingsDialog > Models`
   （组件与逻辑整体复用）；配置落 .env（LLM_*）+ 传给 dsh 的 env 注入层。
4. 完成态：写安装完成标记 → 跳转登录/后台。

## 2. 后台（/admin，仅 admin 角色）

| 页面 | 功能 |
|---|---|
| /admin/accounts | 创建用户（不开放注册）；密码哈希存储；匿名开关（默认开，匿名=内置账号自动签发 JWT） |
| /admin/resources | 资源管理器：文件夹树 + 右键菜单 + 双击打开；可上传视频/图片/音频；每用户根文件夹隔离（匿名也有）；.shufa 任务文件夹可见其元数据与 agent 会话 id |
| /admin/settings | 准备步骤重跑（同一套手风琴组件）；Models 配置（同一套组件）；管理员改密（需原密码；.env 明文兜底不怕丢）；站点域名（默认 http://HOST:PORT，对外链接用它拼接） |

## 3. 前台（/）

- 未认证且匿名关闭 → Dialog 登录（JWT）；匿名开 → 自动匿名 JWT。
- **list-detail**：左列任务列表（时间倒序，进行中+历史）；右列默认最新任务详情。
- 任务详情 = **agent 对话**（移植 skill-creator-v2 聊天 UI；素材视频做特殊展示——
  agent 不读视频，我们上传后把文件路径+提示词发给 agent，agent 自行调工具编排）。
- **结果页** `/r/{public_id}`：.shufa 的"结果"视图（即现 6173 分析页），独立
  分享/打开，默认公开。

## 4. 路由与权限矩阵

页面路由：`/`（前台）、`/setup`（未配置）、`/admin/*`（admin）、`/r/{public_id}`（公开）、`/login`。

API 路由与权限：

| 路由 | 方法 | 权限 |
|---|---|---|
| /api/bootstrap | GET | 公开（返回：是否需安装/是否允许匿名/站点名） |
| /api/setup/admin · /api/setup/steps · steps/{id}/run · steps/{id}/run?force=1 · /api/setup/complete | POST/GET | 仅未配置态；完成后 403 |
| /api/auth/login · /api/auth/anonymous · /api/auth/refresh · /api/me | POST/GET | 公开/持 JWT |
| /api/admin/users (GET/POST) · users/{id} (PATCH) · /api/admin/settings/* (GET/PUT) · /api/admin/password (POST) · /api/admin/wizard/* (GET/POST) | CRUD | admin |
| /api/tasks (GET 列表/POST 创建+上传) · /api/tasks/{id} (GET) · /api/tasks/{id}/cancel (POST) | — | 认证（仅本人资源） |
| /ws/tasks/{id} | WS | 认证（本人） |
| /api/res/** 资源树/上传/删除/改名 | CRUD | 认证（仅本人文件夹） |
| /r/{public_id} · /api/results/{public_id} · /api/results/{public_id}/assets/* | GET | 公开 |

JWT 载荷：{sub: user_id, role: admin|user|anonymous, exp}；资源访问一律
`owner_id == sub`（admin 豁免）；结果页公开匿名可读。

## 5. SQLite 模式

```sql
users(id PK, username UNIQUE, password_hash, role, created_at, disabled)
settings(key PK, value)                      -- 运行时设置（.env 为引导密钥源）
wizard_steps(id PK, kind CHECK(command|download), title, command, url,
             target_dir, status, last_log, updated_at)
blobs(hash PK, size, store_path, ref_count)  -- 内容寻址，去重存储
resources(id PK, owner_id FK, parent_id FK NULL, name, is_dir,
          content_hash FK NULL, size, meta JSON,   -- .shufa 文件夹 meta 含
          created_at, updated_at)                  -- agent_session_id/result_id
tasks(id PK, resource_id FK(.shufa), owner_id FK, status CHECK(queued|running|
      done|failed|cancelled), prompt, video_resource_id FK,
      agent_session_id, result_id FK, created_at, updated_at)
results(id PK, public_id UNIQUE, task_id FK, owner_id FK, title,
        bundle_path, created_at)              -- public_id 用 nanoid（公开访问）
```

存储布局：`<data_root>/blobs/{hash[:2]}/{hash}`；`<data_root>/users/{username}/…`
（资源树是逻辑视图，实体在 blobs）；`<data_root>/dsh-home/`（DSH_HOME）；
`.shufa` 文件夹实体 = 资源树目录（project.json + result/ 分析包 + 元数据）。

## 6. agent 工作流拆分（capability→工具注入）

管线重构为离散步骤命令（`shufa_tool.steps`：probe/sample/orient/align/bg/grid/
ink/clip/transcribe/export），由 daemon 的 capability 层暴露为 agent 工具
（照 skill-creator-v2 的 `CapabilityDefinition`：name + Zod schema + authority
(readonly|proposal) + handler；readonly 步骤 agent 直调，写型步骤走 proposal）。
**summary 步骤不提供工具——由 agent 读取转录与画面产物后亲自撰写**（替换模式
匹配的产品缺漏）。agent 提示词注入：任务目标 + 视频文件路径 + 步骤清单 +
完成后调用 export 生成结果链接。通用 fs/shell/web 工具按 deny-list 收窄。

## 7. WebSocket 事件（帧模型，照搬 skill-creator-v2）

统一帧 `Frame { at, seq, kind, text?, toolName?, payload? }`，kind ∈
user-text / assistant-delta / assistant-text / tool-call / tool-result /
todo-snapshot / status / step / turn-end…；WS 推送 + `afterSeq` 游标重放
（jsonl 落盘）；任务状态机事件（queued/running/done/failed/cancelled）与
步骤级进度同名帧承载。

## 8. .env 约定

```
ADMIN_USERNAME= / ADMIN_PASSWORD=      # 为空 → 安装向导
JWT_SECRET=
SITE_BASE_URL=                         # 默认 http://HOST:PORT
LLM_PROVIDER= / LLM_BASE_URL= / LLM_API_KEY= / LLM_MODEL=   # 向导第 3 步写入
DATA_ROOT=./data                       # blobs/users/dsh-home 根
```

## 9. 工程结构与实施波次（并行子代理）

```
shufa-server/               # 新产品根（pnpm 单仓）
├─ daemon/                  # TS 应用后端：oRPC-WS + SQLite + dsh 内核 + capability
│  ├─ src/kernel/           #   dsh boot / sessions / 帧投影（移植自 skill-creator-v2）
│  ├─ src/capability/       #   分析步骤工具注册（shell → shufa_tool.steps）
│  ├─ src/db/  src/auth/  src/wizard/  src/resources/
├─ webui/                   # Svelte 5 + shadcn-svelte（移植 agent/settings 组件）
├─ skills/shufa/            # SKILL.md + 步骤说明（agent 引用）
└─ ../shufa-tool/           # 既有 Python 管线 + 新增 steps.py（不动已有 cli）
```

- W2'：daemon 地基——pnpm 工程、SQLite schema+迁移、.env、JWT(scrypt)、
  bootstrap 门控、oRPC-WS 骨架、静态托管、vitest。
- W3：webui——Svelte5 + shadcn-svelte 壳：安装向导三步（含 Models 对话框移植）、
  登录 Dialog、后台三页骨架、前台 list-detail 骨架、结果页路由。
- W4：dsh 内核集成（boot/sessions/帧/审批）+ capability→MCP 投影 + deny-list。
- W5：资源管理器（内容寻址 + 文件夹树 + 右键/双击 + 上传）。
- W6：Python `steps.py` 离散步骤 + skills 文档 + WS 帧接通 + 结果页公开路由。
- W7：联调 + 端到端真实浏览器走查。

路由/权限/模式以上文为准；实现与本文冲突时先改本文（Spec 针对意图）。
