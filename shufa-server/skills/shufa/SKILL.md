---
name: shufa
description: 书法/讲评视频分析管线（shufa_tool.steps）离散步骤手册：probe→sample→orient→align→bg→grid→ink→clip→transcribe→export 逐步调用、中间产物检查、摘要撰写指引与分析包导出。供编排 agent 逐步驱动 Python 分析管线时参照。
---

# shufa 分析步骤手册（写给 agent）

把一段书法/作业讲评视频变成可分享的分析包（田字格生字 + 老师旁注时间线 +
语音转录 + 摘要 + 焦点回放剪辑）。管线已拆为**离散步骤命令**，由你逐步调用：
每步可独立重跑/检查中间产物；**summary 由你亲自撰写**（不要指望规则摘要）。

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
  产物落盘 + `WORKDIR/manifest.json` 逐 步合并。步骤必须按序执行；
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
| 8 | `clip VIDEO WORKDIR [--enhance on]` | 格字/旁注/焦点裁剪增强 + 焦点回放剪辑 | `crops/grid_*.png`、`crops/anno_*.png`、`crops/focus.png`、`focus_clip.mp4` |
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
- **clip**：`bbox` 为焦点区（对齐坐标系）；`crops/grid_*.png` 是各格字的
  增强裁剪——**看这些图识别每个格里的字**，下一步写标签要用。

## 你的核心工作：transcribe 之后、export 之前

### 1. 阅读转录全文 + 旁注截图，撰写 summary.json

把 `manifest.transcribe.segments` 的 `text` 按序拼成全文通读；再看
`crops/anno_*.png`（旁注墨迹渲染图）与 `crops/grid_*.png`（格内字）。
然后写 `summary.json`：

```json
{
  "topic": "桂",
  "paragraphs": [
    "本段视频围绕「桂」字书写讲评：老师指出它是左右结构……",
    "……"
  ],
  "key_points": ["书写要领：左收右放，竖画对正", "部件拆解：木字旁 + 圭"]
}
```

- `topic`：本段讲解的核心生字（单字，从转录句式「这个 X 的 X 字」或画面格内字判断）。
- `paragraphs`：2-4 段，概括老师讲了什么（结构/笔画/常见错误），用转录原话提炼，不要编造。
- `key_points`：可执行的书写要领列表（结构、偏旁、占格、纠错点）。
- 这份文件经 `--summary-file` 注入，**完全替代**内置规则摘要。

### 2. 写 labels.json（可选但推荐）

```json
{
  "grids":       [{"index":0,"label":"树"},{"index":1,"label":"桂"},{"index":2,"label":"柱"}],
  "annotations": [{"index":0,"desc":"△△ 记号：此处顿笔"},{"index":1,"desc":"方框记号：部件过散"}]
}
```

- `grids[].index` 对应 grid/ink/clip 步 JSON 里的格序号（`crops/grid_<index>.png`）；
  `label` 写你从裁剪图里认出的字。
- `annotations[].index` 对应旁注序号（`crops/anno_<index>.png`）；`desc`
  用一句话描述该旁注记号。
- 裸数组 `["树","桂","柱"]` 等价于只有 grids。
- export 时管线自动做旁注↔生字关联（转录时间窗命中标签直取，否则回退空间最近格）。

### 3. export 导出

```bash
# 独立 CLI（绝对路径示例）；产品会话内调用 mcp__shufa__export，路径相对 cwd
uv run python -m shufa_tool.steps export /abs/WORKDIR \
  --summary-file /abs/summary.json --labels /abs/labels.json
```

产出 `WORKDIR/bundle/`：`data.json` + `assets/`（格字/旁注 PNG、`focus_clip.mp4`、
预览帧）。stdout JSON 给出 bundle 绝对路径，把它上报给调用方即可。

## 常见问题

- **报"缺少前置步骤产物"**：按 list 顺序补跑；manifest.json 记录了已有进度。
- **视频旋转不对**：orient 用 `--rotate 90|180|270` 手动指定（绕过内容探测；
  手动模式不触发拼音 180° 裁决）。
- **格框/旁注检不出**：先看 `page_bg.png` 是否干净纸面、`debug_grids.png`
  红框位置；采样不足可 `sample --fps 3` 后重跑 orient 起的全部步骤。
- **转录质量**：教学高频同音字已内置修正（桂字/对齐等）；segment.text 可信。
- **不要直接改 bundle 内文件**；一切通过步骤命令与注入文件完成。
