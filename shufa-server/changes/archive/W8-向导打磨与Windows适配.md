# W8：向导打磨与 Windows 适配

> **归档（2026-09-25）**：三线（daemon 引擎 / webui UI / Windows 审计）代码
> 工作完成并全绿；验收清单中 Owner 项「Windows 真机适配验证」未执行——按
> Owner 安排转后续真机测试（发现问题回炉或开 W9，验证通过前不宣称 Windows
> 支持）。归档不含「已完成真机验证」语义。

日期：2026-09-23 ｜ 前序：W1–W7b（见 `.agents/documents/2026-09-22-shufa-analysis/工作报告.md`
与 `PRODUCT_DESIGN.md` v0.2）｜ 类型：产品打磨 + 平台适配

## 1. 背景：Owner 走查反馈六条要点（按转述）

1. **状态文案两模式未分开**：安装向导（setup）与后台「准备步骤重跑」（admin
   wizard）共用同一套状态文案/步骤视图，两种场景下用户看到的措辞没有区分。
2. **dsh 包名错**：向导种子里 dsh 安装命令的 npm 包名不对（现为
   `@open-dsh/cli`，应为 `@deepseek-ai/dsh`）。
3. **webui-install 冗余**：向导准备步骤中的「前端依赖安装与构建（npm install）」
   一步属冗余（pnpm 工程下 `npm install` 口径本身就不对，且安装期不应强迫
   用户构建前端）。
4. **whisper 模型选择**：whisper 转写模型当前硬编码 `ggml-base` 单一下载项，
   应提供模型选择（base/medium/large 等档位）。
5. **whisper 下载镜像与断点续传**：模型下载默认走 huggingface.co，国内环境
   不可达/极慢——需要镜像源（如 hf-mirror.com）支持；大模型文件（百 MB 级）
   下载中断后须能断点续传，而不是从头再来。
6. **Windows 初步适配**：产品需要在 Windows（优先 win11，兼容高版本 win10）
   上可用，本轮先做静态审计与初步适配，真实 Windows 验证由 Owner 后续执行。

## 2. 范围与分工（三线并行）

| 线 | 负责 | 范围 | 边界 |
|---|---|---|---|
| daemon 引擎线 | 代理 A | `daemon/src/wizard.ts`（种子命令三平台分支、whisper 模型选择/镜像/断点续传、webui-install 退役）+ `contracts/`（向导契约扩展） | 只动 wizard.ts 与 contracts/ |
| webui UI 线 | 代理 B | `webui/`（安装向导/后台准备步骤的状态文案分型、模型选择控件、按钮 gating） | 只动 webui/ |
| Windows 审计线（本线） | 代理 C | daemon 其余源码只读审计 + 确凿小修；`README.md` Windows 章节；`shufa-tool/README.md` Windows 说明 | 不碰 wizard.ts / contracts/ / webui/ |

## 3. Windows 审计实施记录（本线）

### 3.1 已修（确凿小修，行为在 mac/linux 不变）

| # | 文件 | 问题 | 修法 |
|---|---|---|---|
| 1 | `daemon/src/http.ts` | 资产/静态两处 containment 只查 `path.relative().startsWith('..')`。Windows 多盘符下，`path.relative` 对另一盘符的目标返回**绝对路径**（无 `..` 前缀），检查放行 → `/api/results/{pid}/assets/C:/…` 类 URL 可跨盘读任意文件（mac/linux 无此面） | 两处均补 `path.isAbsolute(rel)` 判断（同 `capability/analysis.ts` `contains()` 既有正确口径） |
| 2 | `daemon/src/kernel/profile-mirror.ts` | dsh profile 镜像的 `symlinkSync(…, 'dir')`：Windows 建目录符号链接需管理员权限或开发者模式（SeCreateSymbolicLinkPrivilege），普通用户启动即 EPERM → 内核降级不可用 | Windows 分支改 `junction`（无需提权、语义等价；junction 要求绝对 target，本处满足）；非 Windows 保持 `'dir'` 原样 |
| 3 | `daemon/src/kernel/prompts.ts` | `defaultSkillDocPath` 手写 `${dir}/../skills/...` 拼路径 | 改 `path.join`（Windows 反斜杠语义统一走 node:path） |
| 4 | `daemon/src/tasks/service.ts` | `shufaToolDir()` 固定三级 `..`：只对 `runtime/w7b.env` 正确；产品默认的仓库根 `.env` 会解析到**仓库外两级**的 `shufa-tool`（本机实证：`/Users/kzf/Documents/shufa-tool` 不存在），uv `--project` 必失败 | 两级候选（envDir 的上一级/上两级）按 `pyproject.toml` 存在性择优，同 `config.ts` webuiDir 的既有模式；`SHUFA_TOOL_DIR` 覆盖优先级不变 |

### 3.2 审计后记录（不修，附理由）

- **`capability/analysis.ts` `execFile('uv', …)`**：不经 shell、参数数组直传（无
  cmd 元字符注入面）。Windows 下 CreateProcess 按 PATH 搜索并自动补 `.exe`，
  官方安装的 `uv.exe` 理论可被寻址——**未实测**，列入验证清单。
- **`wizard.ts` 种子命令**（`brew/apt-get`、`npm install`、probe `test -d` unix
  命令、dsh 包名）：全部属 daemon 引擎线（代理 A）职责，本线不改。
- **`scripts/w7b-e2e.mjs`**：unix 主义（`lsof` 探端口、负 pid 进程组整杀、
  macOS Chrome 硬编码路径、`/tmp` 默认 DATA_ROOT）——**仅限 mac/linux 调试
  使用**，不做 Windows 改造；README 已注明。
- **`db/blobs.ts` `store_path`**：按 `path.join` 落库（Windows 存反斜杠）。
  单平台自洽；**数据目录/SQLite 文件不做跨 OS 迁移**（迁移需重建 store_path）。
- **`tasks/service.ts` `linkSync`**：Windows/NTFS 支持硬链接；跨盘符/特殊文件
  系统失败时已有 `copyFileSync` 回退，无需改。
- **`writeFileSync(…, { mode: 0o600 })`**：Windows 忽略 mode 位（无害，不报错）。
- **信号**：Windows 无 SIGTERM；`index.ts` 已注册 SIGINT（Ctrl+C 触发），优雅
  停机链路（会话 dispose → 内核 dispose → 有界停机 → 关库）在 Windows 走
  SIGINT 即可，不改代码。
- **内核 dsh**：以 `@deepseek-ai/dsh-*` SDK **进程内嵌**（非 spawn 外部可执行
  文件），「npm 全局 bin 是 .cmd」的风险面只存在于向导 probe 命令（经
  `shell: true` 执行，cmd 可解析 `dsh.cmd`）；`DSH_HOME` 注入 Windows 绝对路径
  由 dsh-home-paths 处理，**未实测**。
- **tsx / esbuild / vitest**：纯 JS + 按平台二进制（esbuild 有 win32 包），无阻塞。
- **better-sqlite3 v13.0.3**：npm 包**自带** win32-x64 / win32-arm64 预编译
  （N-API，与 Node 小版本解耦，engines ≥22），Node 24 正常无需 VS Build
  Tools；仅源码编译兜底时才需要。已写入 README。

### 3.3 文档交付

- `README.md`：新增「Windows（初步适配，未测试）」章节（依赖安装命令、启动
  流程、.env 指引、已知未验证点清单）；顺带修正快速启动的 `pnpm start`
  （根包无 start 脚本，实际命令为 `pnpm --filter @zhumo/daemon start`）。
- `shufa-tool/README.md`：新增「Windows 说明（初步适配，未测试）」（uv sync
  不带 transcribe extra、ffmpeg PATH、未验证点）；代码零改动。

## 4. 未测试声明（重要）

> **本轮 Windows 适配属静态适配：所有结论来自代码审计与官方文档推写，
> winget 安装行为、PATH 生效方式、junction 镜像链路、uv/ffmpeg 对中文路径的
> 实际表现、防火墙/SmartScreen 交互等均未经真实 Windows 环境验证。**
> Owner 将在真实 Windows（win11 优先）机器上按 README「Windows」章节做适配
> 验证；验证中发现的问题回炉本波或开 W9。在验证通过前，**不得对外宣称
> Windows 支持**。

## 5. 验收标准清单

- [ ] **状态文案分型**：安装向导（首次 setup）与后台准备步骤（admin 重跑）
      两个模式的状态文案/措辞可区分，走查可辨（webui 线 + daemon 线）。
- [ ] **按钮 gating**：未完成前置步骤时后续按钮不可用（或显式 force 语义），
      已完成/失败/运行中状态下的可点按钮集合符合设计（webui 线）。
- [ ] **whisper 模型选择**：向导可选择模型档位；选择结果持久化（DB 种子），
      重启不丢（daemon 线）。
- [ ] **whisper 镜像 + 断点续传**：下载走可配镜像源；中断后续传从已收字节
      继续（`.part` 保留 + Range/续写），中断恢复后无需从头下载（daemon 线）。
- [ ] **种子迁移不破坏既有 admin 数据**：种子清单变更（dsh 包名修正、
      webui-install 退役、whisper 多模型）后，老库 `wizard_steps` 既有状态行
      不被覆盖/不丢 admin 已配置数据（`seedWizardSteps` 幂等语义回归）
      （daemon 线）。
- [ ] **Windows 审计小修回归**：本线 4 项小修后 daemon 测试全绿（实施时点
      10 文件/65 用例通过；同窗并发改动的 wizard 线测试由该线自行收敛），
      `pnpm -r typecheck` 0 错。
- [ ] **（Owner，Windows 真机）适配验证**：按 README Windows 章节逐项走通
      依赖安装 → 启动 → 向导 → 建任务 → 结果页，记录偏差。
