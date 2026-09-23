"""教学内容总结：规则驱动的启发式摘要（无外部 LLM 依赖时可用）。

意图（2026-09-22）：从转录文本 + 视觉产物（格内字/旁注）提取教学要点。
策略：书法教学高频关键词词典命中 → 组装结构化要点；支持 --summary-file
注入人工/AI 生成的更优摘要覆盖默认输出。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# 书法课堂教学关键词 → 要点类别
KEYWORDS: dict[str, str] = {
    "左右结构": "结构",
    "上下结构": "结构",
    "半包围": "结构",
    "独体字": "结构",
    "木字旁": "偏旁",
    "提手旁": "偏旁",
    "三点水": "偏旁",
    "草字头": "偏旁",
    "土字": "部件",
    "两个土": "部件",
    "土": "部件",
    "圭": "部件",
    "对齐": "书写要领",
    "对正": "书写要领",
    "靠里": "书写要领",
    "纠正": "书写要领",
    "注意": "书写要领",
    "压线": "书写要领",
    "占格": "书写要领",
}


@dataclass
class Summary:
    topic: str = ""                       # 本片段讲解对象（如「桂」）
    paragraphs: list[str] = field(default_factory=list)
    key_points: list[str] = field(default_factory=list)
    keywords_found: dict[str, list[str]] = field(default_factory=dict)  # 类别 → 词
    source: str = "heuristic"             # heuristic | injected


def _topic_from_transcript(text: str) -> str:
    """从转录中找"X 的 X 字/X花的X"句式定位讲解对象。"""
    import re
    m = re.search(r"这个[\u4e00-\u9fff]{0,3}的[「\"]?([\u4e00-\u9fff])[」\"]?字", text)
    if m:
        return m.group(1)
    for ch in ("桂",):
        if ch in text:
            return ch
    return ""


def summarize(transcript_text: str, focus_char: str = "") -> Summary:
    s = Summary(topic=focus_char or _topic_from_transcript(transcript_text))
    by_cat: dict[str, list[str]] = {}
    for kw, cat in KEYWORDS.items():
        if kw in transcript_text:
            by_cat.setdefault(cat, [])
            if kw not in by_cat[cat]:
                by_cat[cat].append(kw)
    s.keywords_found = by_cat

    topic = s.topic or "生字"
    s.paragraphs.append(
        f"本段视频是围绕「{topic}」字的书写讲评：老师结合练习册上的田字格，"
        f"讲解该字的字形结构与书写注意点，并在格子旁添加了标注。"
    )
    if "结构" in by_cat:
        cats = "、".join(by_cat["结构"])
        s.paragraphs.append(f"老师指出「{topic}」是{cats}的字。")
    for pt in by_cat.get("书写要领", []):
        s.key_points.append(f"书写要领：{pt}")
    for pt in by_cat.get("部件", []):
        s.key_points.append(f"部件拆解：{pt}")
    for pt in by_cat.get("偏旁", []):
        s.key_points.append(f"偏旁：{pt}")
    return s


def load_injected(path: Path, source: str = "injected") -> Summary:
    """--summary-file：JSON {topic, paragraphs, key_points}。
    source 标记实际来源（agent=模型经 summary_write 亲写 / injected=人工注入），
    走查 2026-09-23：固定 "injected" 使 agent 亲写的摘要来源不可辨。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    return Summary(
        topic=data.get("topic", ""),
        paragraphs=data.get("paragraphs", []),
        key_points=data.get("key_points", []),
        source=source,
    )
