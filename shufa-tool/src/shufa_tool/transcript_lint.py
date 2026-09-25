"""转录同音字 lint（Owner 要求「写入结构化数据时自动 lint」，2026-09-25 重构）。

沿革：audio.ZH_FIXES 短语修正表（60fde54）按整短语硬匹配，whisper 输出一换
变体即漏网——实证导出 72uzF2CLBNDF：「要注意这个柜」因不带「子」逃过
「柜子→桂字」词条，「烤箭」更是表外词。本模块改为锚点驱动：以本视频生字
集合（labels 格 label + 焦点字）为锚，转录文本中与锚点字**同音同调**异字的
汉字判为误转，导出时自动校正并留痕（warnings + transcript.lint_fixes）。

匹配口径（Owner 顾虑「图/土」误伤，2026-09-24 修正表注释实证）：
- 带调匹配（TONE3）：土=tu3 / 图=tu2 不同调不命中，杜绝一刀切换「图」；
  桂=gui4 / 柜=gui4 同音同调命中——正是要抓的高频误转。
- 只替换「与锚点同音异字」的单字；锚点字自身与无关字一律不动。
- 同调多锚点（罕见）视为歧义，整键放弃不修。
- 无法锚定的整词误转（烤箭→考卷）不做硬修——由更强模型与人工复核兜底。
- pypinyin 未安装时整体降级跳过（不阻断导出）。
"""

from __future__ import annotations

from dataclasses import dataclass

try:  # 可选依赖：lint 能力随依赖在场而启用（uv sync 默认装；旧环境无则降级）
    from pypinyin import Style, lazy_pinyin
except ImportError:  # pragma: no cover
    lazy_pinyin = None
    Style = None  # type: ignore[assignment]


@dataclass
class LintFix:
    """一次校正留痕（写入 transcript.lint_fixes 与 warnings）。"""

    seg: int      # 段下标（0 起）
    wrong: str    # 误转字（转录原文）
    right: str    # 校正为（锚点生字）
    context: str  # 命中段原文（截断，供人工复核）


def _anchor_map(subject_chars) -> dict[str, str]:
    """带调 pinyin → 锚点字。同音同调多锚点（罕见）删键（歧义不修）。"""
    if lazy_pinyin is None or Style is None:
        return {}
    anchors: dict[str, str] = {}
    ambiguous: set[str] = set()
    for ch in subject_chars:
        if not isinstance(ch, str) or len(ch) != 1:
            continue
        py = lazy_pinyin(ch, style=Style.TONE3)[0]
        if not py:
            continue
        if py in anchors and anchors[py] != ch:
            ambiguous.add(py)
        anchors[py] = ch
    for py in ambiguous:
        anchors.pop(py, None)
    return anchors


def lint_and_fix(
    segments: list[dict], subject_chars
) -> tuple[list[dict], list[LintFix]]:
    """转录段 × 生字锚点同音校正。

    返回（修正后的 segments 浅拷贝列表, 校正留痕）。原文 list 不被改动
    （manifest 保持引擎原始输出，校正只发生在导出面——留痕可溯源）。
    """
    if lazy_pinyin is None or Style is None:
        return list(segments), []
    anchors = _anchor_map(subject_chars)
    if not anchors:
        return list(segments), []
    anchor_chars = set(anchors.values())

    fixed: list[dict] = []
    fixes: list[LintFix] = []
    for i, seg in enumerate(segments):
        text = str(seg.get("text", ""))
        pys = lazy_pinyin(text, style=Style.TONE3) if text else []
        if not text or len(pys) != len(text):
            # 空段 / 多音节合并异常（连续拉丁等）：保守跳过
            fixed.append(dict(seg))
            continue
        buf: list[str] = []
        seg_fixes: list[LintFix] = []
        for ch, py in zip(text, pys):
            right = anchors.get(py)
            if right is not None and ch != right and ch not in anchor_chars:
                buf.append(right)
                seg_fixes.append(
                    LintFix(seg=i, wrong=ch, right=right, context=text[:40]))
            else:
                buf.append(ch)
        new_text = "".join(buf)
        fixed.append({**seg, "text": new_text} if seg_fixes else dict(seg))
        fixes.extend(seg_fixes)
    return fixed, fixes
