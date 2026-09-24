---
name: shufa
description: 书法/作业讲评视频分析管线（shufa_tool.steps）离散步骤手册 + 书法领域知识库（kb_* 工具）使用规约：probe→sample→orient→align→bg→grid→ink→clip→transcribe→export 逐步调用；总结撰写先取知识库「总结模式」按转录匹配（兜底优先，命中才叠加）；知识库管理模式（征得同意后经 kb 写工具沉淀知识，全程 git 留痕）。供编排 agent 逐步驱动分析管线时参照。
---

# shufa 分析步骤手册（写给 agent）

把一段书法/作业讲评视频变成可分享的分析包（田字格生字 + 老师旁注时间线 +
语音转录 + 摘要 + 焦点回放剪辑）。本手册只含**稳定工作流**；书法领域知识与
总结模式都在**知识库**里（后台长期演进，与本文件解耦）。

**能力边界（重要）**：你看不到图片。格子里写了什么字、旁注画了什么记号，
只能从语音转录与步骤返回的 JSON 元数据推断；转录没提到的，就留空、如实说明，
不要猜。

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
| 9 | `transcribe VIDEO WORKDIR` | mlx-whisper 转录（可选依赖） | `audio.wav`、manifest.transcribe{segments} |
| 10 | `export WORKDIR --summary-file F [--labels F] [--out-dir D]` | 你的摘要/标签注入 + 旁注↔生字关联 → 分析包 | `bundle/`（data.json + assets/） |

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

## 你的核心工作：transcribe 之后、export 之前

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
  "paragraphs": ["…", "…"],
  "key_points": ["…"]
}
```

- `topic`：本段讲解的核心生字（从转录句式「这个 X 的 X 字」判断）。
- `paragraphs`：2-4 段；骨架来自模式，血肉来自老师原话（引用要忠实），
  术语对照知识条目写准（例如老师口头的部件位置关系，用规范结构用语表述，
  但不得无中生有）。
- `key_points`：可执行的书写要领列表。
- 经 `--summary-file` 注入，**完全替代**内置规则摘要。

### 3. 写 labels.json

```json
{
  "grids":       [{"index":1,"label":"桂","note":"本格要点：…"}],
  "annotations": [{"index":0,"desc":"…"}]
}
```

- `grids[].index` 对应 grid/ink/clip 步 JSON 里的格序号；`label` **只标转录
  明确点到的字**（通常对应焦点格）；转录没提到的格**留空**（你看不到图片，
  练习页可能有多个不同生字，猜错比留空更糟）；`note` 可选，写本格讲解要点。
- `annotations[].desc`：结合转录判断这条旁注在指出什么问题（一句话）。
- export 时管线自动做旁注↔生字关联（转录时间窗命中标签直取，否则回退空间最近格）。

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
