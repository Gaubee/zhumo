# shufa-transcribe · 语音转录工具（Qwen3-ASR）

> 决策日期：2026-10-01。朱墨（zhumo）的独立音频转录组件：课程录音（中文为绝对主体、偶发英文术语）→ 文本。
> 选型背景：Whisper large-v3 中文 CER 5.14%，落后国产第一梯队 5-10 倍，故整体迁移至 Qwen3-ASR。
> 边界：**shufa-tool 管线内的 transcribe 步骤当前仍用 mlx-whisper（W9 决策）**，与本组件相互独立；
> 管线引擎切换待后续按本组件实测结论推进。

## 结论与平台矩阵

| 平台 | 引擎 | 模型（默认 small） | 依赖 | 支持等级 |
|---|---|---|---|---|
| macOS Apple Silicon（**Mac mini**） | MLX | moona3k/mlx-qwen3-asr-0.6b-4bit（517MB） | python3.10+ / venv | ★ 主力，已实测 |
| Linux + NVIDIA | CUDA | Qwen/Qwen3-ASR-0.6B（bf16） | python3.10+ / CUDA | ★ 批量服务器 |
| 任意平台（含 Windows / Intel Mac） | CPU | SenseVoice-Small int8（228MB） | python3.10+ | 兜底 |

三引擎统一入口、统一输出（同名 `.txt`），平台探测自动选择，`--engine` 可强制切换。

## 架构

```
bun shufa-transcribe/transcribe.sh.ts <音频/目录> [--engine --model --lang --context --out]
        │
        │ ①输入收集(文件/递归目录) ②引擎选择(--engine > env > 平台探测)
        ▼
   ffmpeg 规范化 ──→ 16kHz 单声道 s16 WAV（已是 WAV 则直通）
        │
        ├──darwin/arm64──→ engines/mlx.ts ──→ venv: mlx-qwen3-asr CLI ──┐
        ├──linux+cuda───→ engines/cuda.ts ─→ venv: cuda.py(qwen-asr) ───┤
        └──其它─────────→ engines/cpu.ts ──→ venv: cpu.py(sherpa-onnx) ─┤
                                                                        ▼
                                              统一写出 <音频名>.txt（旁边或 --out）
```

## 快速开始

```bash
# 1. 部署（首次，自动建 venv + 装依赖 + 下载模型；按平台自动选引擎）
bun shufa-transcribe/setup.sh.ts

# 2. 自检（macOS 会用 say 合成一句中文自动验收）
bun shufa-transcribe/check.sh.ts

# 3. 日常使用（从仓库根目录执行）
bun shufa-transcribe/transcribe.sh.ts 录音/第01课.m4a                # 单文件，txt 写在音频旁边
bun shufa-transcribe/transcribe.sh.ts 录音/ --out 转录/              # 目录批量
bun shufa-transcribe/transcribe.sh.ts 第01课.m4a --context "楷书 行书 中锋 侧锋 提按 转折 飞白"  # 书法热词（慎用，见已知限制 5）
```

模型档位：`--model small`（默认，快）→ mlx 0.6B-4bit / cuda 0.6B；`--model large`（更准）→ mlx 1.7B-8bit / cuda 1.7B。也可直接传完整 HF id。

## Mac mini 部署 runbook

```bash
# 前置：ffmpeg（非 WAV 输入需要）；python ≥3.10（brew python3.14 实测可用；
# 若 PATH 里 uv 的 python3 排前面也没关系——setup 优先找版本化的 python3.14）
brew install ffmpeg python@3.14

# 一次性部署 + 自检
bun shufa-transcribe/setup.sh.ts
bun shufa-transcribe/check.sh.ts      # 期望输出 "✓ PASS：转录出中文文本"

# 首次转录会从 HF 自动拉模型；直连慢则走镜像：
export HF_ENDPOINT=https://hf-mirror.com
```

验收标准：check.sh.ts PASS（中文文本非空）+ 用一段真实课程录音人工抽查（教学口语/教室混响与评测基准有差距，必须实测）。

## 选型依据（为什么换掉 Whisper）

第三方 24 测试集统一评测（2026-03，FireRedASR2 技术报告口径）中文 CER：

```
FireRedASR2-AED(1.1B) 0.57%  ┐
Qwen3-ASR-1.7B        ~1.5%  ├ 国产第一梯队（本组件选 Qwen3-ASR：中文梯队 + 中英混合最系统 + MLX 原生）
Paraformer-Large      1.68%  ┘
SenseVoice-Small      2.96%  ← CPU 兜底（比 Whisper 仍好，且 228MB/CPU 飞快）
Whisper large-v3      5.14%  ← WenetSpeech 会议场景 18.87%，差距拉大到 5-10 倍
```

- **Qwen3-ASR**：30 语言 + 22 中文方言，中英混合训练最系统；Apache-2.0；mlx-qwen3-asr 为作者从零重写的 MLX 实现（编码器与 PyTorch 参考误差 <0.003，M4 Pro 上 0.6B RTF≈0.03）。
- **SenseVoice**：CPU 兜底，全平台（Win/macOS/Linux，x64/arm64），带标点与 ITN。注意选 2024-07-17 版（2025-09-09 粤语增强版**无标点**）。
- 英文偶发内容两模型均可覆盖；纯英文高要求场景另议（Phonon-2 等专用模型）。

## 高级用法（mlx 引擎直用 CLI）

统一入口只输出纯文本；时间戳/字幕/说话人分离等能力由 venv 内 CLI 直接提供：

```bash
shufa-transcribe/.venv/bin/mlx-qwen3-asr 会议.m4a --timestamps            # 词级时间戳
shufa-transcribe/.venv/bin/mlx-qwen3-asr 课程.m4a -f srt -o 字幕/          # SRT/VTT 字幕
shufa-transcribe/.venv/bin/mlx-qwen3-asr 座谈.m4a --diarize -f json        # 说话人分离（需 export PYANNOTE_AUTH_TOKEN）
```

CUDA 服务器批处理：`qwen_asr.Qwen3ASRModel.from_pretrained(..., max_inference_batch_size=32)`（transcribe 支持路径数组批量）。

## 已知限制

1. **仅离线批处理**。Qwen3-ASR 伪流式模式有重复输出缺陷（上游 issue #129），本工具不暴露流式。
2. cpu 引擎（SenseVoice）无时间戳、无热词上下文。
3. 未在 Windows 实机验证（sherpa-onnx 官方支持 Windows，理论可跑，标记为 best-effort）。
4. 量化有轻微损失：mlx small 用 4-bit（test-other 约 +1.4pp）；追求极致精度用 `--model large`。
5. **热词 `--context` 慎用（2026-10-01 实测）**：中文列举句（「横、竖、撇、捺、点」）加热词后被截断为「——横。」，模型过度偏向 context 词反而丢内容。默认不加；仅当某术语被系统性识别错时针对性启用。

## 实测记录（2026-10-01，iMac arm64 / macOS 27 / bun 1.4.2 / Python 3.14 / mlx 0.32.3）

- `setup.sh.ts`：幂等通过（含 SOCKS 代理环境，已内置 `httpx[socks]`）。
- `check.sh.ts`：PASS——say(Tingting) 合成「大家好，今天我们一起来学习楷书的基本笔画：横、竖、撇、捺、点。」识别为「…笔画：横、竖、撇、捺点。」（仅一处顿号差异）；模型缓存后单次 3.5s（含加载）。
- `transcribe.sh.ts` 主入口：全链路 2.4s/24 字，`.txt` 正确落盘。
- 踩坑备忘：Bun.spawn 对不存在的可执行抛 ENOENT 而非返回非零（lib.ts 已防御）；uv 管理的解释器（含版本化符号链接）建 venv 会坏（`No module named 'encodings'`），setup 对候选逐个实测健康度并以 Homebrew 绝对路径兜底，现存坏 venv 自动重建。

## 故障排查

| 症状 | 处置 |
|---|---|
| `引擎未就绪` | `bun shufa-transcribe/setup.sh.ts --engine <mlx|cuda|cpu>` |
| `未找到 python ≥3.10` | macOS `brew install python@3.14`；Ubuntu `apt install python3.12 python3.12-venv` |
| venv 异常 / `No module named 'encodings'` | uv 等独立构建建的 venv 是坏的——setup 已内置候选逐个实测+异常自动重建，正常无需干预；全部候选失败时 `brew install python@3.14` 后重跑 setup |
| SOCKS 代理报 `socksio not installed` | setup 已内置 `httpx[socks]`；若手动建过 venv 则重跑 setup |
| 模型下载慢/失败 | `export HF_ENDPOINT=https://hf-mirror.com` |
| 非 WAV 报 ffmpeg 缺失 | `brew install ffmpeg` / `apt install ffmpeg` |
| 结果⚠️无中文 | 音频语言与预期不符；`--lang Chinese` 强制；或录音质量问题 |
| 加热词后内容变少 | `--context` 负优化（见已知限制 5），去掉重试 |
| CUDA OOM | `--model small`；或改用 cpu 引擎跑通先验证 |

## 领域词汇

见 [i18n.zh.md](i18n.zh.md)（转录/ASR 术语 + 书法热词表，一手/二手来源区分）。

## 上游参考

- mlx-qwen3-asr：github.com/moona3k/mlx-qwen3-asr（CLI/量化模型/Python API）
- Qwen3-ASR 官方：github.com/QwenLM/Qwen3-ASR（qwen-asr 包、vLLM 后端）
- sherpa-onnx SenseVoice：k2-fsa.github.io/sherpa/onnx/sense-voice（模型 tar.bz2、全平台）
