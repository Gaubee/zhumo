"""教学内容总结：规则驱动的启发式摘要（无外部 LLM 依赖时可用）。

意图（2026-09-22）：从转录文本 + 视觉产物（格内字/旁注）提取教学要点。
策略：书法教学高频关键词词典命中 → 组装结构化要点；支持 --summary-file
注入人工/AI 生成的更优摘要覆盖默认输出。
"""

from __future__ import annotations

import json
import re
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
    # 终态契约：元素为 {kind,text[,source]} 三态对象（heuristic 摘要仍产
    # 纯 string——读端兼容；类型上二者并存，故不标 str）。
    paragraphs: list = field(default_factory=list)
    key_points: list = field(default_factory=list)
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
    走查 2026-09-23：固定 "injected" 使 agent 亲写的摘要来源不可辨。
    终态契约（Codex 五审 P1-1 对等）：paragraphs/key_points 元素一律
    {kind,text[,source]} 对象——fact 必带非空 source（转录段下标整数数组，
    从 0 起）；纯字符串不再接受（与 daemon summary_write 同规）。"""

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("summary 结构未达终态契约：顶层必须是 JSON 对象")
    topic = data.get("topic", "")
    if not isinstance(topic, str) or not topic:
        raise ValueError("summary 结构未达终态契约：topic 必须是非空字符串")
    for field_name in ("paragraphs", "key_points"):
        items = data.get(field_name, [])
        if not isinstance(items, list) or not items:
            raise ValueError(f"summary 结构未达终态契约：{field_name} 必须是非空数组")
        for i, item in enumerate(items):
            if not isinstance(item, dict) or item.get("kind") not in (
                "fact",
                "inference",
                "suggestion",
            ):
                raise ValueError(
                    f"summary 结构未达终态契约：{field_name}[{i}] 必须是 {{kind,text[,source]}} 对象（纯字符串已废弃）："
                    "fact=老师原话（必带 source 段下标）/ inference=分析 / suggestion=建议"
                )
            if not isinstance(item.get("text"), str) or not item["text"]:
                raise ValueError(f"summary 结构未达终态契约：{field_name}[{i}].text 必须是非空字符串")
            if item["kind"] == "fact":
                src = item.get("source")
                if (
                    not isinstance(src, list)
                    or not src
                    or not all(
                        isinstance(x, int) and not isinstance(x, bool) and x >= 0 for x in src
                    )
                ):
                    raise ValueError(
                        f"summary 结构未达终态契约：{field_name}[{i}].source 必须是非空转录段下标数组（整数，从 0 起）"
                    )
    return Summary(
        topic=data.get("topic", ""),
        paragraphs=data.get("paragraphs", []),
        key_points=data.get("key_points", []),
        source=source,
    )


# 归一化：与 daemon normalizeClaimText 同规（去空白与标点）。
_STRIP_RE = re.compile(r"[\s，。、；：？！,.;:?!\"'（）()「」『』…—·]")
# 任意长度配对引号（捕获组供逐字核验）。
_QUOTE_CAP_RE = re.compile(r"「([^」]+)」|“([^”]+)”|『([^』]+)』")


def _norm(t: str) -> str:
    return _STRIP_RE.sub("", t)


def validate_summary_evidence(summary: dict, segment_texts: list[str]) -> list[str]:
    """claim 证据核验（daemon factEvidenceErrors/nonFactQuoteErrors 的 Python
    对等实现——Codex 六/七审：CLI 注入路径不能只查形状，须同样核语义证据）：
    - 空转录：fact 一律拒绝（无证据可引；仅允许 inference/suggestion）；
    - fact：source 界内且严格递增；任意长度引文逐字出自所引段拼接；每句
      ≥4 字连续原文锚点且不跨段，<4 字短句须整句出现在所引某段；
    - 非 fact：任意长度引文对转录全文逐字（1 字引号同样是原话声明）。
    顶层/元素形状不稳定输入返回结构错误而非抛 AttributeError。返回错误
    列表（空=通过）。"""
    if not isinstance(summary, dict):
        return ["summary 顶层必须是 JSON 对象"]
    full_norm = _norm("".join(segment_texts))
    errors: list[str] = []
    for field_name in ("paragraphs", "key_points"):
        items = summary.get(field_name, [])
        if not isinstance(items, list):
            errors.append(f"{field_name} 必须是数组")
            continue
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"{field_name}[{i}] 必须是对象")
                continue
            where = f"{field_name}[{i}]"
            kind = item.get("kind")
            if kind == "fact":
                if not segment_texts:
                    errors.append(f"{where} 无转录可引（fact 需要转录证据；改用 inference/suggestion）")
                    continue
                src = item.get("source", [])
                if any(not isinstance(x, int) or isinstance(x, bool) or x >= len(segment_texts) or x < 0 for x in src):
                    errors.append(f"{where} 引用了不存在的转录段（共 {len(segment_texts)} 段）")
                    continue
                if any(src[k] <= src[k - 1] for k in range(1, len(src))):
                    errors.append(f"{where} 的 source 必须是严格递增的去重下标序列")
                    continue
                seg_norms = [_norm(segment_texts[x]) for x in src]
                scope = "".join(seg_norms)
                text = item.get("text", "") if isinstance(item.get("text"), str) else ""
                for m in _QUOTE_CAP_RE.finditer(text):
                    inner = m.group(1) or m.group(2) or m.group(3) or ""
                    if _norm(inner) not in scope:
                        errors.append(f'{where} 引文「{inner}」未见于其声明的来源段')
                for sent in re.split(r"[。；！？\n]", text):
                    ns = _norm(sent)
                    if not ns:
                        continue
                    if len(ns) < 4:
                        if not any(ns in seg for seg in seg_norms):
                            errors.append(f'{where} 的句子无原文支撑：「{sent}」')
                        continue
                    anchored = any(ns[k : k + 4] in seg for seg in seg_norms for k in range(len(ns) - 3))
                    if not anchored:
                        errors.append(f'{where} 的句子无原文锚点：「{sent}」')
            else:
                text = item.get("text", "") if isinstance(item.get("text"), str) else ""
                for m in _QUOTE_CAP_RE.finditer(text):
                    inner = m.group(1) or m.group(2) or m.group(3) or ""
                    if _norm(inner) not in full_norm:
                        errors.append(f'{where} 引文「{inner}」未见于转录')
    return errors
