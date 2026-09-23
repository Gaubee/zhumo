# shufa-tool — 书法/作业讲评视频分析 CLI

输入一段手机拍摄的书写讲评视频（可能有旋转问题），产出**分析包**（data.json + assets/），
由 Vite 构建的网页应用（TypeScript）通过 HTTP 服务承载：
自定义播放器 + 时间轴同步字幕/关键帧、田字格截取、旁注时间线与生字关联、转录与总结。

## 用法

```bash
cd shufa-tool
uv sync --extra transcribe            # 首次；transcribe extra 仅 macOS/arm64 生效

# 分析 + 启动服务（默认 6173 端口，自动构建 dist 并静态承载）
uv run shufa-analyze 视频.mp4 --serve

# 仅产出分析包不启服务；之后可独立承载
uv run shufa-analyze 视频.mp4 --no-serve
uv run shufa-serve .shufa-work/视频/bundle            # 构建 + 纯静态服务（零 Node 查看期依赖）
uv run shufa-serve .shufa-work/视频/bundle --dev      # vite dev（前端开发调试）

# 常用参数
--fps 2 --rotate auto        # 采样率 / 转正方式（auto|0|90|180|270）
--enhance off                # 关闭音画增强（默认 on：afftdn+loudnorm / hqdn3d+eq）
--transcribe off             # 跳过音频转录
--labels labels.json         # 格标签/旁注描述注入（见下）
--summary-file summary.json  # 精修摘要注入（覆盖默认规则摘要）
```

## 架构

```
视频.mp4 ──shufa-analyze──▶ 分析包 bundle/
                             ├─ data.json      数据契约（类型定义 web/src/types.ts）
                             └─ assets/        田字格/旁注/关键帧 PNG、预览帧 JPG、回放 mp4
web/（Vite + TS strict）──npm run build──▶ dist/（编译出的静态网页）
shufa-serve ──▶ 构建缓存命中则跳过，dist 上起静态 HTTP 服务（支持 Range 视频跳转）
```

- **数据结构是正式契约**：`data.json` 的 schema 定义在 `web/src/types.ts`
  （strict TS + 运行时校验），Python 侧由 `export.export_bundle` 产出。
- **Vite 只用于开发**：查看期是编译产物 + 纯静态服务；`--dev` 才起 vite dev。
- **音画增强默认开**（一次性编码成本）：音频 afftdn 降噪 + loudnorm 响度归一
  （EBU R128）；画面 hqdn3d 降噪 + eq 轻度统一调色。

## 设计取舍速记（详见工作报告）

- **旋转**：容器无 metadata 时纯视觉探测。FFT 谱峰占比而非高频 std——后者会被
  纸板斜边/桌面交界等锐利孤立边缘虚假抬高；180° 依赖"拼音在格上方"的领域启发式。
  另一独立根因：**透视裁剪的角点顺序**。approxPolyDP 输出的角点顺序取决于轮廓
### labels.json / summary.json（可选，人工或上层 AI 提供）

```json
{
  "grids":       [{"index": 0, "label": "杨"}, {"index": 1, "label": "桂"}],
  "annotations": [{"index": 0, "desc": "△△ 与开口方框记号：强调左右两部分"}]
}
```
summary.json：`{"topic": "桂", "paragraphs": [...], "key_points": [...]}`。

## 设计取舍速记（详见工作报告）

- **旋转（两级）**：容器无 metadata 时，纸面墨迹行投影 FFT 谱峰占比消 90° 步进
  （高频 std 会被纸板斜边虚假抬高）；拼音标签带多数票消 180°。
- **角点必须规范化 + 剖面吸附精化**：approxPolyDP 角点顺序取决于轮廓追踪方向
  （实证三格全部 180° 倒置）；eps=0.08 粗角点可偏 3~6px 且可被邻域墨迹带偏
  25px（桂格实证）——`grid.refine_quad` 用"暗度覆盖剖面峰值吸附"（印刷边框
  覆盖率 0.95 完胜局部笔画）逐角精化，裁剪取角点来源帧（零跨帧误差）。
- **格框几何取自单帧**：合成背景即便对齐后，亚像素残差仍会洗掉 1px 印刷线（实测
  边框命中率 11%）；多帧投票 + 无手帧降权解决"手污染几何"。
- **笔迹检测**：铅笔对比度仅 5~15 灰阶，单帧时隐时现（实测同像素对比度 6↔94 波动）；
  "复现 ≥4 帧"既容忍闪烁又排除瞬态噪声，优于 AND 持久化（抹真）与 OR 合成（聚假）。
- **SAM3 不引入**：规则印刷网格是确定性任务，OpenCV 毫秒级零模型内存；
  SAM3 FP16 单图 ~8-10GB，16GB 机器（swap 已 9.4/10GB）不适用。

## 已知局限

- 被前景物（垫板）遮挡过半的格（如"柏"）不检出——宁缺毋假。
- 180° 自动裁决依赖拼音标签带；无拼音页面用 `--rotate` 手动指定。
- 旁注语义（△△/口口/圭 是什么意思）不在 CV 层解决——由上层 AI/人工经
  `--labels`/`--summary-file` 注入。
- 转录同音字（"桂字"→"柜子"）仅对常见书法教学词做了修正表（audio.py ZH_FIXES）。

## Windows 说明（初步适配，未测试）

**本节为静态推写的初步说明，尚未在真实 Windows 环境验证。**

- 分析主体（probe→sample→orient→align→bg→grid→ink→clip→export）为
  OpenCV + numpy + ffmpeg，Windows 理论可用：安装 Python ≥3.12 与 uv
  （`powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`）后
  `uv sync` 即可；ffmpeg 需在 PATH（`winget install -e --id Gyan.FFmpeg`，
  装完重开终端）。
- **不要安装 transcribe extra**：mlx-whisper 仅 macOS/arm64。Windows 下
  `uv sync`（不带 `--extra transcribe`），转录步骤按「无环境自动跳过」处理。
- 未验证点：路径含中文/空格的端到端行为、控制台中文输出编码（如遇乱码
  `chcp 65001`）、OpenCV/ffmpeg 轮子在目标 Windows 版本的可用性。
