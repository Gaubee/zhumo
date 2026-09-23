# 朱墨（shufa-server）

书法/作业讲评视频的多用户分析与 agent 编排平台：上传讲评视频，agent 按工作流
（探针→抽帧→旋转探测→对齐→背景合成→田字格检测→角点精化→旁注提取与生字关联
→回放剪辑（含音画增强）→转录→摘要→导出）自动完成分析，产出可独立分享的
结果页。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Python | ≥3.11 + [uv](https://docs.astral.sh/uv/) | 分析管线（`shufa-tool/`） |
| Node.js | ≥24 + pnpm ≥9 | 服务端 daemon 与前端构建 |
| ffmpeg | 任意近期版本（PATH 可寻） | 视频/音频处理 |
| dsh | ≥0.1.1 | agent 内核 |

## 快速启动

```bash
# 1) 安装依赖
pnpm install                       # daemon + webui
cd ../shufa-tool && uv sync        # 分析管线（含转录 extra）

# 2) 配置（可选：首次启动会进入安装向导，逐步引导）
cp .env.example .env               # 按需修改；敏感信息不进 git

# 3) 构建 + 启动
pnpm build
pnpm --filter @zhumo/daemon start   # 根目录无 start 脚本；默认 http://127.0.0.1:8217
```

首次访问（无 `.env` 或 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 为空）会自动进入
**安装向导**：①设置管理员账号 → ②准备步骤（ffmpeg/dsh 探测、whisper 模型
下载、前端构建——已存在默认跳过，可强制重跑）→ ③大模型服务配置。
完成后即可登录使用。

## .env 配置项

```ini
ADMIN_USERNAME=            # 留空则首次进入安装向导
ADMIN_PASSWORD=
JWT_SECRET=                # 留空则向导生成并写回
SITE_BASE_URL=             # 对外链接拼接域名，默认 http://HOST:PORT
DATA_ROOT=./data           # SQLite/blobs/会话/资源存储根
LLM_PROVIDER=              # 大模型服务（向导第 3 步会写入）
LLM_API=                   # 可选：wire 协议（openai-completions / anthropic-messages）
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

> 管理员的初始账号密码保存在 .env 作恢复凭证；之后在后台修改的密码存于
> 数据库（哈希），不回写 .env。

## 页面

| 路径 | 说明 | 访问 |
|---|---|---|
| `/` | 前台：任务列表 + agent 对话详情 | 登录/匿名（匿名可在后台关闭） |
| `/r/{public_id}` | 分析结果页（可独立分享） | 公开 |
| `/setup` | 安装向导 | 仅未配置时 |
| `/admin` | 后台：账号管理/资源管理/设置 | 仅管理员 |

## 目录结构

```
daemon/   TS 应用后端（oRPC-over-WS + SQLite + dsh 内核 + 工具面）
webui/    Svelte 5 + shadcn-svelte 前端（构建产物由 daemon 托管）
skills/   注入给 agent 的工作流说明书
data/     运行时数据（ blobs/ 用户资源/ dsh-home/）——git 忽略
```

分析管线本体在仓库 `../shufa-tool/`（Python），以离散步骤命令
（`python -m shufa_tool.steps <step>`）暴露给 agent 编排。

## 真实 agent E2E（W7b，Owner 供 LLM 凭据后一键跑）

```bash
# 全链：全新 DATA_ROOT 起 daemon → admin 向导（Models 写入真实 key）→
# 上传真实视频建任务 → 轮询帧直到 done（15 分钟上限）→ 断言：
#   assistant-text 摘要帧 / summary.json 落盘 .shufa / results 行+public_id /
#   登出态 GET /r/{public_id} 200 且页面渲染摘要与视频（headless Chrome）。
# LLM_API 可选（openai-completions / anthropic-messages，缺省 anthropic-messages）：
# 网关只讲 OpenAI 协议时必须显式指定（实证：Z.ai /api/paas/v4 走 openai-completions）。
LLM_PROVIDER=zai LLM_BASE_URL=https://api.z.ai/api/paas/v4 \
LLM_API=openai-completions LLM_API_KEY=xxx LLM_MODEL=glm-4.7 \
node scripts/w7b-e2e.mjs

# 无 key 链路回归（占位 LLM，跑到「建任务+失败收敛」为止，不跑真实模型）：
node scripts/w7b-e2e.mjs --dry-run
```

可调环境变量：`PORT`（默认 8239）、`DATA_ROOT`（默认 /tmp/shufa-w7b/data，每次
自动清空）、`VIDEO`（默认仓库旁 `../20260922-124852.mp4` 同级真实视频）、
`TIMEOUT_MS`（默认 900000）、`CHROME_PATH`（结果页渲染断言用，默认找系统
Chrome）。脚本结束自动杀 daemon/Chrome；PASS/FAIL 逐项输出，退出码 0/1。

> 该脚本为 mac/linux 调试专用（lsof 探端口、macOS Chrome 路径、`/tmp` 默认
> DATA_ROOT），Windows 不适用，亦未做兼容改造。

## Windows（初步适配，未测试）

**本节为初步适配说明，尚未在真实 Windows 环境验证。** 以下安装命令与行为按
win11（兼容高版本 win10）静态推写：依据是代码审计（全程 node:path、无 unix
专有命令依赖 daemon 主链路）与官方文档，Owner 将在真实 Windows 机器上逐项
验证；遇到偏差以实际报错为准排查。

### 依赖安装（PowerShell 管理员不需要，逐条执行）

| 依赖 | 安装命令 | 说明 |
|---|---|---|
| Node ≥24 | `winget install -e --id OpenJS.NodeJS.LTS` | Node 24 已进入 LTS 线，该 winget 包即 24 系列；或到 [nodejs.org](https://nodejs.org/zh-cn/download) 下载 MSI 安装 |
| pnpm ≥9 | `corepack enable`（Node 24 自带 corepack）或 `npm install -g pnpm` | 仓库 `packageManager` 钉定 pnpm@10.17.1，corepack 会自动采用该版本 |
| Python ≥3.12 + uv | `winget install -e --id Python.Python.3.12`，然后 `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"` | uv 官方 PowerShell 安装脚本；装完重开终端让 PATH 生效（`uv --version` 自检） |
| ffmpeg | `winget install -e --id Gyan.FFmpeg` | **装完必须重开终端** PATH 才生效（`ffmpeg -version` 自检） |
| dsh | `npm install -g @deepseek-ai/dsh` | agent 内核；npm 全局 bin 在 Windows 落为 `dsh.cmd`，向导探测命令经 shell 执行可正常解析 |

### 启动（与 macOS 流程相同）

```powershell
pnpm install                        # workspace 三包（daemon/webui/contracts）一次装齐
pnpm build                          # 含 webui 构建
pnpm --filter @zhumo/daemon start   # 默认 http://127.0.0.1:8217
```

- 仓库当前工作区已带预编译的 `webui/dist`，拿到含 dist 的目录时可直接启动、
  跳过 `pnpm build`；但 `.gitignore` 忽略 `dist/`，经版本库克隆得到的代码
  **不含** dist，必须先执行 `pnpm build`（等效 `cd webui && pnpm install && pnpm build`）。
- 分析管线在仓库**同级**的 `../shufa-tool/`（与 shufa-server 并列放置即可，
  daemon 按 .env 位置两级候选自动定位）；放别处时设环境变量
  `SHUFA_TOOL_DIR=<shufa-tool 绝对路径>`。
- 首次访问进入安装向导（`.env` 会自动生成模板）；各配置项含义见上文
  「.env 配置项」章节，Windows 下路径值可直接写盘符路径（如
  `DATA_ROOT=D:\shufa\data`）。
- 依赖也可先按上表手工装好，再回到向导「准备步骤」用嗅探确认（已装默认跳过）。

### 已知未验证点（Windows 专项清单）

- **路径含中文/空格**：开发机路径含中文「书法」。Node 内部按 UTF-16 处理路径、
  ffmpeg ≥4 用宽字符 API，理论可用；但 uv/Python 子进程的输出编码与控制台代码页
  未经实测（如遇乱码可 `chcp 65001`）。稳妥起见，部署建议用**纯 ASCII 且不含
  空格**的路径。
- **better-sqlite3 编译链**：v13 的 npm 包内自带 win32-x64 / win32-arm64 预编译
  二进制（N-API，与 Node 小版本解耦），正常**无需** VS Build Tools；仅当安装
  期命中源码编译兜底时才需要 Visual Studio Build Tools（含「使用 C++ 的桌面
  开发」工作负载）。
- **防火墙弹窗**：首次启动若 Windows 防火墙弹「允许访问」，本产品默认只绑
  `127.0.0.1`，拒绝弹窗亦不影响本机使用；需要局域网访问时放行并把 `.env` 的
  `HOST` 改为 `0.0.0.0`（自行评估暴露面）。
- **转录（whisper）不可用**：shufa-tool 的 transcribe extra 依赖 mlx-whisper，
  仅 macOS/arm64 生效；Windows 上转录步骤按「无环境自动跳过」语义跳过，其余
  九步分析照常（结果页字幕/逐字/旁注关联区将为空数据）。
- **向导准备步骤的 Windows 命令分支**：种子命令目前是 brew/apt-get 口径，
  winget 分支在适配中；Windows 下以手工安装 + 嗅探跳过为准。
- **信号退出**：Windows 无 SIGTERM，标准退出方式是终端 `Ctrl+C`（SIGINT），
  优雅停机（会话回收 + 内核 dispose + 关库）逻辑不变。
- dsh 内核以 SDK 进程内嵌（非外部可执行文件），`DSH_HOME` 注入的是 Windows
  绝对路径，其 profile 镜像目录链接已按 junction 处理（无需管理员权限），
  但该链路未经真实 Windows 验证。
