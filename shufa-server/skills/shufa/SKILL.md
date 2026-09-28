---
name: shufa
description: 书法/作业讲评视频分析管线（shufa_tool.steps）离散步骤手册 + 书法领域知识库（kb_* 工具）使用规约：probe→sample→orient→align→bg→grid→ink→clip→ocr→transcribe→export 逐步调用；总结撰写先取知识库「总结模式」按转录匹配（兜底优先，命中才叠加）；知识库管理模式（征得同意后经 kb 写工具沉淀知识，全程 git 留痕）。供编排 agent 逐步驱动分析管线时参照。
---

# shufa 分析步骤手册（写给 agent）

把一段书法/作业讲评视频变成可分享的分析包（田字格生字 + 老师旁注时间线 +
语音转录 + 摘要 + 焦点回放剪辑）。本手册只含**稳定工作流**；书法领域知识与
总结模式都在**知识库**里（后台长期演进，与本文件解耦）。

**能力边界（重要）**：你看不到图片。`ocr` 返回的是模型机器感知，可帮助理解
多字练习页的对象，但不是老师口述证据，也不等于人工确认。正式 `labels.json`
中的格字 `label` 仍只标转录明确点名的字；OCR 结果只能出现在独立的
`label_ocr` 字段，不能填充或验证 `label`、summary fact、旁注描述。

## 调用方式

独立使用时在 shufa-tool 仓库根（含 pyproject.toml）执行：

```bash
uv run python -m shufa_tool.steps <command> [args]
uv run python -m shufa_tool.steps list   # 内置说明（与本手册一致）
```

朱墨产品会话内**不经 shell**：直接调用 `mcp__shufa__probe`、`mcp__shufa__summary_write`
等 MCP 工具（下列步骤命令的工具投影）。产品内所有路径参数（workdir/video 等）
用**相对当前工作目录的相对路径**（你的 cwd 即用户根目录，如 `<任务目录>/.shufa`），
由工具面解析后再落到磁盘。

**约定（严格遵守）**：

- 每步 **stdout 末行恒为一行 JSON**（机器可读结果）；人类日志走 stderr。
  解析 stdout 最后一行 JSON 判断步骤结果。
- 失败时退出码非 0，stdout 末行 `{"step":"…","error":"中文原因"}`。
- 状态接力：所有步骤读写同一 `WORKDIR`（建议 `<任务目录>/.shufa-work/`），
  产物落盘 + `WORKDIR/manifest.json` 逐步合并。步骤必须按序执行；
  跳步会得到明确报错（按提示补跑前置步骤即可）。
- 每次完整分析在 `clip` 后都应调用 `ocr`，让结果包为每格附上机器识别候选；
  OCR 步骤失败时记录失败并继续 `transcribe`/`export`，不得用 OCR 候选填充正式标签或证据。
- 步骤可安全重跑（幂等覆盖）；`probe` 会重置整个 WORKDIR（= 重开一次分析）。
- `VIDEO` 建议始终传同一段视频的同一路径（产品会话内为相对 cwd 的相对路径；
  独立 CLI 用绝对路径）；与 manifest 不一致会 stderr 警告。

## 步骤清单（按序）

| # | 命令 | 作用 | 关键产物 |
|---|---|---|---|
| 1 | `probe VIDEO WORKDIR` | ffprobe 元数据，初始化 WORKDIR | manifest 基座（分辨率/时长/有无音轨） |
| 2 | `sample VIDEO WORKDIR [--fps 2.0]` | 均匀抽帧 | `frames/f_*.jpg` + ts 序列 |
| 3 | `orient WORKDIR [--rotate auto]` | 内容投影转正（90° 步进；180° 疑义留给 grid 裁决） | manifest.orient{steps,note} |
| 4 | `align WORKDIR` | 相位相关逐帧对齐 | manifest.align |
| 5 | `bg WORKDIR` | 无笔迹页面背景 + 手活动量 | `page_bg.png`（预览版） |
| 6 | `grid WORKDIR` | 田字格检测 + 拼音带 180° 裁决 + 角点精化 | `debug_grids.png`、`page_bg.png`（最终版）、manifest.grid{grids,sides} |
| 7 | `ink WORKDIR` | 动态墨迹/旁注簇 + 出现时间线 + 焦点格 | `crops/anno_mask_*.png`、manifest.ink/focus |
| 8 | `clip VIDEO WORKDIR [--enhance on]` | 格字/旁注/焦点裁剪增强 + 焦点回放剪辑 | `crops/grid_*.png`、`crops/anno_*.png`、`focus_clip.mp4`（给最终报告读者的素材；你看不到其内容） |
| 9 | `ocr WORKDIR [--ocr-size medium\|small]` | PP-OCRv6 单格识别（独立机器感知步骤；medium 默认，tiny 不开放） | manifest.ocr{model,size,grids} |
| 10 | `transcribe VIDEO WORKDIR` | 转录（可选依赖） | `audio.wav`、manifest.transcribe{segments} |
| 11 | `export WORKDIR --summary-file F [--labels F] [--out-dir D]` | 你的摘要/标签注入 + 旁注↔生字关联 → 分析包 | `bundle/`（data.json + assets/） |

## 输出 JSON 样例（stdout 末行）

```json
{"step":"probe","video":"/abs/v.mp4","width":1920,"height":1080,"duration_s":31.5,"fps":30.0,"has_audio":true,"metadata_rotation_cw":0.0}
{"step":"sample","fps":2.0,"frames":64}
{"step":"orient","cw_steps":1,"note":"内容探测：顺时针 90°（投影得分 …）"}
{"step":"align","frames":64,"max_abs_shift":[8.5,1.8]}
{"step":"bg","frames":64}
{"step":"grid","grids":3,"sides":[75,75,75,75],"cw_steps":1,"flipped":false}
{"step":"ink","annotations":3,"first_ts":[9.0,15.0,28.5],"dropped_clusters":0,"focus_grid_idx":1}
{"step":"clip","duration_s":31.5,"bytes":2380000,"timeline":4,"bbox":[x0,y0,x1,y1]}
{"step":"ocr","model":"PP-OCRv6_medium","grids":3,"recognized":3,"results":[{"idx":0,"label_ocr":"字","label_ocr_conf":0.9}]}
{"step":"transcribe","segments":9,"model":"mlx-community/whisper-large-v3-turbo"}
{"step":"export","bundle":"/abs/WORKDIR/bundle","grids":3,"annotations":3,"entries":13}
```

`transcribe` 无 mlx 环境（或视频无音轨）时**不阻塞**：
stdout 输出 `{"step":"transcribe","skipped":"transcribe","reason":"…"}`，
继续走 export（转录/字幕条目为空）。

## 每步之后建议检查什么

- **grid**：`sides` 应为近似等长列表（如 [75,75,75,75]）；`grids` 数量与
  `debug_grids.png` 红框一致。`flipped:true` 表示拼音带裁决又转了 180°。
- **ink**：`annotations` = 旁注簇数；`first_ts` 为各旁注首现秒数；
  `focus_grid_idx` 是讲评焦点格（周边旁注活动最强）。
- **clip**：`bbox` 为焦点区（对齐坐标系）。crops 产物给最终报告的读者看，
  你的语义判断依据是转录与各步 JSON，不是这些图。
- **ocr**：`label_ocr` 是机器识别候选；空串和 `0` 置信度是合法失败态。可参考
  OCR 理解多字视频讲评对象，但不据此写正式 `label` 或转录事实。若模型不可用，
  记录 OCR 步骤失败并继续导出；`export` 不要求 OCR 已成功。
- **transcribe**：返回值携带转录全文（`transcript_text`）与 segments——
  摘要与标签撰写以它为准。

## 你的核心工作：transcribe 之后、export 之前

摘要（summary）与标签（labels）必须由你亲自撰写后经 `mcp__shufa__summary_write`
提交——没有替你生成摘要的工具。

### 1. 模式匹配：kb_list 扫描「总结模式」

调用 `mcp__shufa__kb_list`（无参数）拿到知识库目录（分组 + 组内条目名，
好比书架类别与书名）。定位「**总结模式**」组，通读它的条目名：

- **兜底模式**（条目名以「兜底·」开头）：任何时候可用，无命中时的保底；
- **结构化模式**：条目内容里有「触发」一行（匹配词清单）——拿老师转录全文
  对照，**命中才叠加，可多选，一个都没命中就只用兜底**。

对选中的模式逐个 `mcp__shufa__kb_get({group:"总结模式", key:"…"})` 取全文，
按其「关联」行提到的分组，再取需要的知识条目（如「结构法则」组的某条法则）。
知识条目是**规范用语与要领的来源**，用于把老师的口语表述落成准确的书面总结；
老师**没讲过**的不要写。

### 2. 撰写 summary.json

把转录 segments 按序拼成全文通读，然后按「选中模式的骨架 + 老师原话 +
知识条目」撰写：

```json
{
  "topic": "…",
  "paragraphs": [
    {"kind":"fact","text":"…","source":[0,1]},
    {"kind":"inference","text":"…"}
  ],
  "key_points": [
    {"kind":"fact","text":"…","source":[3]},
    {"kind":"suggestion","text":"…"}
  ]
}
```

- `topic`：本段讲解的核心对象。判定不依赖单一句式——「这个 X 的 X 字」「第
  X 格」「这个字」乃至通篇只讲一个字都可能是线索；多字视频写「A、B 两字」，
  拿不准就写「多字讲评」并如实说明归属不确定。
- **三类内容严格分栏（终态契约 2026-09-27：fact 必须携带转录段引用）**——
  paragraphs/key_points 的元素**一律是对象**，三种 kind：
  1. **转录事实** `{"kind":"fact","text":…,"source":[…],"label":…}`：老师
     说过的话。`source` = 转录 segments 的**下标数组**（transcribe 步返回的
     segments 按顺序从 0 编号；一句话横跨几段就列几个下标，**必须严格
     递增**）。text 是对这些段的忠实转述；**任意长度的引号**（「」『』，
     哪怕只有一个字）其内容都必须逐字出现在 source 的**连续段拼接**里
     （跨 gap 拼接是伪引文）。**子句级溯源锚点（写入校验硬拦）**：text
     按 逗号/顿号/冒号/破折号/句号 切分成子句，每个子句的非引文散文须含
     ≥4 字连续原文且不跨段（<4 字短子句须整句出现在所引某段）。豁免仅
     两条：引文**前** ≤6 字且含言语动词（说/讲/强调/指出…）且无否定词
     的引导语（「老师强调」类；**否定词会翻转引文语义，一律不豁免**）；
     展示性标签走独立的 **`label` 字段**（如 `"label":"书写要领"`，≤12 字，
     结果页渲染为加粗前缀）——**不要把「标签：」写进 text**（文本内冒号
     前缀同样要过锚点核验）。夹带老师没说的内容（如「而且每天练习一百
     遍」）会整句被拒。老师的语气、态度、肯定与否也只能在转录明示时
     陈述。**纯字符串会被直接拒绝写入**（schema 层面不再接受）。
  2. **分析推断** `{"kind":"inference","text":…}`：你结合画面产物与知识
     条目的判断——如「中轴」「重心」「比例」这类老师没说出的机理、以及
     「从画面产物看」的判断，一律声明为 inference，不得伪装成 fact。
  3. **练习建议** `{"kind":"suggestion","text":…}`：你自己给出的练法、
     遍数、口令、路径。
  每一句陈述必须归入三类之一，不得把推断写成老师观点。知识条目的规范用语
  只用于把老师的话**说得更准**，不得**添加老师没表达的判断、度量或法则**。
- **写完自检（run6/AFk7o 两轮实证）**：逐条检查 fact——凡 text 里出现老师
  没说过的几何/机理/重要性判断（垂直线、中轴、重心、正对、正下方、最关键、
  最容易出错、匀称、比例……），要么改 `{"kind":"inference",…}`，要么删掉；
  再逐句核对每条 fact：句子里有 ≥4 字连续原文锚点、引文逐字出自所引段。
- **视觉动作禁令（写入校验硬拦）**：你看不到画面——「圈画」「示范」「划出」
  「勾出」「红笔」「笔迹」等视觉动作词不得出现在任何段落或 labels desc 中
  （转录原话的引号内除外）。旁注的画面细节一律不写，只写时间与转录能支撑
  的内容。
- `paragraphs`：2-4 段（内容多可到 5 段，宁可分段也不压缩串题）；骨架来自
  模式，血肉来自老师原话（引用要忠实），术语对照知识条目写准（例如老师
  口头的部件位置关系，用规范结构用语表述，但不得无中生有）。
- `key_points`：可执行的书写要领列表（同样遵守三类分栏）。
- 经 `--summary-file` 注入，**完全替代**内置规则摘要。

### 3. 写 labels.json

```json
{
  "grids":       [{"index":1,"label":"<生字>","note":"本格要点：…"}],
  "annotations": [{"index":0,"desc":"…"}]
}
```

- `grids[].index` 对应 grid/ink/clip 步 JSON 里的格序号；`label` **只标转录
  明确点到的字**（通常对应焦点格）；转录没提到的格 **label 留空串 `""` 或
  干脆不写该格条目**——你看不到图片，练习页可能有多个不同生字，猜错比留空
  更糟。**绝不为了通过校验而编造占位标签**（如「未点名格」之类的字面量：
  它会被当成生字渲染并参与关联，比留空更糟——f202ed82 实证）；`note`
  可选，写本格讲解要点。
  一字写了多格（同一个字写了 3 遍）→ **仅在逐格有证据时才同标**——写入
  校验硬拦（十二审 run19 回归后机器化）：同一 label 标在 >1 格时，每格
  必须是焦点格（focus.grid_idx）或有旁注墨迹中心落在该格内；不满足即拒
  写。**证据只覆盖焦点格时，其余格一律留空**——「练习页大概率都是同一
  个字」不是证据。结果页会把同字多格聚合展示，旁注按墨迹位置自动挂到
  对应格。
- `annotations[].desc`：结合转录判断这条旁注在指出什么问题（一句话）；
  desc 里只写转录能支撑的内容——旁注的**视觉细节**（画了什么形状、指向
  哪个部件）你看不到图，不要写成事实；如写时间（`t≈15s`），必须与该旁注
  ink 步返回的 `first_ts` 一致（±3s 内）。
- export 时管线自动做旁注↔生字关联（转录时间窗命中标签直取，否则回退空间最近格）。

**summary_write 写入校验（错了会被拒绝写入，必须修复后重写）**：

- 结构：topic/paragraphs（≥1 段）/key_points（≥1 条）非空；元素必须是
  三种对象形态之一（纯字符串拒绝）；labels index 在检测范围内。
- fact 证据：每条 fact 的 `source` 下标必须真实存在（超出 segments 范围
  拒绝写入）且**严格递增去重**；引文须逐字出自 source 的**连续段拼接**
  （跨 gap 拼接是伪引文）；text 的**每个子句**（逗号/顿号/冒号/破折号
  均切分）须含 ≥4 字连续原文锚点且不跨段——<4 字短子句须整句出现在所
  引某段。**豁免只有一条**：引文前的散文**全等**命中引导语白名单
  （老师/老师说/老师强调/老师指出/老师要求/并说/再次强调/随后说/先说/
  原话是…——全等不是包含，「每天说」「讲义」不算）。展示性标签用
  `label` 字段（枚举：讲评对象/开场点题/结构定性/书写要领/核心要点/
  指出问题/卷面问题/处理动作/练习要点/补充说明）。export 前另有终态
  门禁复核 bundle 内 summary——未达契约的导出被拒绝（CLI 注入同规核
  证据；无转录时 fact 一律拒）。
- 引文忠实：paragraphs/key_points 里**任意长度**的引文，**必须逐字出现
  在该条 fact 的 source 所指转录段里**（inference/suggestion 的引文对
  全文核）——只有老师原话才加引号，转述与概括一律不用引号。**引号单层
  使用**：转录原文自带「」时外层用『』（『这个「桂」字啊』✓）；同样式
  嵌套（「…「桂」…」）与不成对引号会被拒绝写入。
- 时间在界：所有 `t≈Xs` 不得超出视频时长（probe 步返回的 `duration_s`）。
- 旁注时间一致：labels desc 里的 `t≈Xs` 与该旁注 `first_ts` 偏差 ≤3s。

### 4. export 导出

产品会话内调用 `mcp__shufa__export`；独立 CLI：

```bash
uv run python -m shufa_tool.steps export /abs/WORKDIR \
  --summary-file /abs/summary.json --labels /abs/labels.json
```

产出 `WORKDIR/bundle/`。stdout JSON 里的 result_url 就是给用户的公开结果
链接，结束时把它和一句总评转告用户。**检查返回的 warnings**：出现
「生字格语义缺失」且确有转录点到的格没标 → 补一次 summary_write 再重导；
转录本来就没提到的格留空，向用户如实说明即可。

## 知识库管理模式（用户请求沉淀/修改知识时）

用户消息要求**整理、沉淀、修正知识库**（如「把这条经验记进知识库」「总结模式
加一个新场景」）时进入此模式——这是唯一允许调用 kb 写工具的场景：

1. `kb_list` 看现状（避免重复建条目；能改现有条目就不新建）。
2. 拟出变更计划（哪个分组、哪个条目、内容全文），**先向用户复述并征得同意**
   （删除分组/条目前必须复述名称与影响范围）。
3. 确认后调用写工具：`kb_save_group` / `kb_save_entry` / `kb_delete_entry` /
   `kb_delete_group`。每次写入自动记入 git 修订历史（后台可查、可恢复）。
4. 汇报结果与一句话说明记了什么。

写知识时同样防过拟合：沉淀**可复用的通则**（触发条件、骨架、规范术语），
不要把单次视频的具体案例、具体字写进知识库。

## 常见问题

- **报"缺少前置步骤产物"**：按 list 顺序补跑；manifest.json 记录了已有进度。
- **视频旋转不对**：orient 用 `--rotate 90|180|270` 手动指定（绕过内容探测；
  手动模式不触发拼音 180° 裁决）。
- **格框/旁注检不出**：先看 `page_bg.png` 是否干净纸面、`debug_grids.png`
  红框位置；采样不足可 `sample --fps 3` 后重跑 orient 起的全部步骤。
- **转录质量**：教学高频同音字已内置修正；kb 里没有的领域知识不要臆造，
  可建议用户走知识库管理模式沉淀。
- **不要直接改 bundle 内文件**；一切通过步骤命令与注入文件完成。
