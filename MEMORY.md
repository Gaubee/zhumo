# 项目记忆（跨会话）

## 架构速览

- `shufa-server/`：pnpm monorepo（daemon=Node/oRPC+sqlite、webui=SvelteKit、contracts=zod 契约）。
- `shufa-tool/`：平级 Python 管线仓库（uv；probe/sample/orient/align/bg/grid/ink/clip/ocr/transcribe/export 步骤，`python -m shufa_tool.steps <step>`）。
- 部署：mini（macmini）launchd `com.zhumo.daemon` 跑 daemon（tsx 源码直跑）+ 静态托管 `webui/dist`；改前端后必须重建 dist 并提交（六审 P1：源码与 dist 漂移会让线上跑旧逻辑）。
- e2e：`webui/e2e-shufa.mts`（mini 上 `cd daemon && npx tsx ../webui/e2e-shufa.mts <视频> ws://127.0.0.1:8217`）。**不清场**——任务/results/产物保留供 Owner 审计（2026-09-27 Owner 质询后立规）。

## 摘要契约迭代轨迹（Codex 复核：4.5→6.0→7.0→7.1→6.9→7.4→7.8→8.1→8.0→8.0→四轮 NO-GO→**GO**；OCR 功能轮 9.5 PASS）

- 词表黑名单机制已被判定为死路（AFk7oLRzFQlm 实证：e2e 与 daemon 同表=网内自洽假阳性；措辞变体追不完）。
- 终态方案（2026-09-27 起）：summary claims 三态对象 `{kind:fact|inference|suggestion, text, source?}`；fact 必带 `source`（转录 segments 下标）。
- 事实门 `factEvidenceErrors`（daemon/src/capability/analysis.ts，e2e/Python 同源/对等）：① source 界内；② 任意长度引文逐字出自所引段（run13「桂」短引号反例）；③ 每句 ≥4 字连续原文锚点且**不跨段**（run12 夹带反例/跨段伪锚点）。判据用 run12/13/14 真实产物校准。
- export 终态门禁 fail-closed：daemon wrapExportCompletion 复核 bundle summary（缺/坏 data.json 拒导出）；python cmd_export 转录在场时对等核证据。
- 已知残余：句内修饰语级夹带（如「下面的」「写得」）无 NLI 级拦截，靠锚点+引文压缩其空间；ASR 音同字修正在 export 期发生、summary_write 核的是原始段（多视频下可能有误伤面）；仅「桂」单视频验证过，非「桂」素材待 Owner 提供。
- 每轮 e2e run 的产物副本在本地 `/tmp/zumo-codex-review/`（summary-run*.json + transcript.txt），mini 上日志 `/tmp/e2e-run*.log`。
- OCR 机器感知（2026-09-29 上线）：PP-OCRv6 medium 默认/small 可选/tiny 不开放（RapidOCR+onnxruntime，`--extra ocr`）；独立步骤 clip→ocr→export；`label_ocr/conf` 不进证据核验不回填 label；向导「OCR 识别模型」步（warm_ocr 预热/--check 探测/换档重下，SHUFA_OCR_SIZE 持久化）。实测同页三格=杨/桂/树（事后证明 run19 三格全猜桂被逐格证据门拦对了）。

## 纪律

- 用户活跃测试时段（有 running 任务）绝不重启 daemon；部署前先查 tasks 表。
- LLM key 任何 RPC 输出面不回显；.env/data/runtime/samples 不提交。
- mini 部署顺序：查无 running → rsync → `launchctl bootout+bootstrap`（kickstart -k 不重载 plist）→ kill 残留 8217 占用 → curl 探活。
