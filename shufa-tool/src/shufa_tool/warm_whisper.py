"""向导 whisper 预热（走查四轮，2026-09-25）。

把管线真正使用的 mlx-whisper 模型（mlx-community/whisper-*）经
huggingface_hub.snapshot_download 预取到 HF 标准缓存——首次分析不再隐式
下载数 GB。镜像经 HF_ENDPOINT（huggingface_hub 官方机制）。

输出协议与向导日志对齐：stdout 每行一条，「已下载 X.XMB / Y.YMB（Z%）」
为进度行（daemon 侧原位替换），其余为普通日志；失败走非零退出码。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import threading
import time
from pathlib import Path

DEFAULT_ENDPOINT = "https://huggingface.co"


def hub_root() -> Path:
    """HF 缓存根（与 huggingface_hub 同一解析：HF_HOME 优先，缺省 ~/.cache/huggingface）。"""
    hf_home = os.environ.get("HF_HOME")
    return Path(hf_home) if hf_home else Path.home() / ".cache" / "huggingface"


def cache_repo_dir(repo: str) -> Path:
    return hub_root() / "hub" / ("models--" + repo.replace("/", "--"))


def dir_size_bytes(path: Path) -> int:
    """目录体积（字节）。跳过符号链接——snapshots/ 里是 blobs 的软链，不跳会
    双计。整段遍历包 try：.incomplete → blob 改名等并发变动会让 rglob 生成器
    中途抛错，此时返回已累计值而非让轮询线程死亡（走查 2026-09-26）。"""
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file() and not p.is_symlink():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return total


def dir_size_mb(path: Path) -> float:
    return dir_size_bytes(path) / 1024 / 1024


def main() -> int:
    ap = argparse.ArgumentParser(description="预热 mlx-whisper 模型到 HF 缓存")
    ap.add_argument("--repo", required=True, help="HF 仓库（如 mlx-community/whisper-tiny）")
    ap.add_argument("--endpoint", default="", help="镜像端点（写入 HF_ENDPOINT）")
    ap.add_argument("--force", action="store_true", help="覆盖下载：先清除该仓库缓存")
    args = ap.parse_args()

    if args.endpoint and args.endpoint != DEFAULT_ENDPOINT:
        os.environ["HF_ENDPOINT"] = args.endpoint
        print(f"镜像端点：{args.endpoint}")
    # 关掉 huggingface_hub 自带 tqdm（Fetching N files 条走 stderr 且含 \r，
    # 会污染向导日志；进度由本脚本统一输出）。
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    # 禁用 Xet 传输（走查 2026-09-26 实证三连）：① 字节进 ~/.cache/huggingface/xet
    # 分块缓存、blobs/.incomplete 恒 0 字节——进度失真；② CAS 端点直连
    # cas-server.xethub.hf.co，绕过 HF_ENDPOINT 镜像；③ 曾「零字节成功」留下
    # 悬空软链（blobs/<etag> → 不存在的 blobs/<sha> 分片）。普通 HTTP 路径的
    # 进度/断点续传/镜像行为全部正确。
    os.environ["HF_HUB_DISABLE_XET"] = "1"

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("[失败] huggingface_hub 未安装（uv sync --extra transcribe）", file=sys.stderr)
        return 3

    target = cache_repo_dir(args.repo)
    if args.force and target.exists():
        shutil.rmtree(target)
        print(f"已清除旧缓存：{target}")

    # 总量探测（一次列表调用；失败则进度不带分母，不影响下载本身）。
    total_mb: float | None = None
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(args.repo, files_metadata=True)
        total_mb = sum((f.size or 0) for f in (info.siblings or [])) / 1024 / 1024
    except Exception as exc:  # noqa: BLE001 - 探测失败仅降级进度显示
        print(f"总量探测失败（进度将不显示百分比）：{exc}")

    stop = threading.Event()
    # 进度量取（走查 2026-09-26）：官方端点的 xet 后端仓库走 Xet 传输——字节先进
    # ~/.cache/huggingface/xet 分块缓存，blobs 里的 .incomplete 恒 0 字节，只量仓库
    # 目录会「流量在跑进度恒 0」（mini 实证）。改为两目录的基线增量：各自记开场
    # 基线，只报增量——历史分块缓存（dedup 复用）不会把起点抬高。
    xet_dir = hub_root().parent / "xet"
    baseline_repo = dir_size_bytes(target) if target.exists() else 0
    baseline_xet = dir_size_bytes(xet_dir) if xet_dir.exists() else 0

    def downloaded_mb() -> float:
        repo = (dir_size_bytes(target) if target.exists() else 0) - baseline_repo
        xet = (dir_size_bytes(xet_dir) if xet_dir.exists() else 0) - baseline_xet
        return (max(0, repo) + max(0, xet)) / 1024 / 1024

    def poll() -> None:
        while not stop.is_set():
            time.sleep(2)
            done = downloaded_mb()
            if total_mb and total_mb > 0:
                pct = min(100, round(done / total_mb * 100))
                print(f"已下载 {done:.1f}MB / {total_mb:.1f}MB（{pct}%）", flush=True)
            else:
                print(f"已下载 {done:.1f}MB / 未知大小", flush=True)

    watcher = threading.Thread(target=poll, daemon=True)
    watcher.start()
    try:
        path = snapshot_download(repo_id=args.repo)
    except Exception as exc:  # noqa: BLE001 - 向导按退出码记失败并展示 stderr
        stop.set()
        print(f"[失败] {exc}", file=sys.stderr)
        return 4
    stop.set()
    watcher.join(timeout=3)  # 让最后一拍进度行落地
    # 完成自检（走查 2026-09-26）：防「零字节成功」——权重文件必须解析到真实
    # 且非空的目标（悬空软链在此拦截，退出码 5）。
    weights = [p for p in Path(path).iterdir() if p.name.endswith((".safetensors", ".npz"))]
    ok = weights and all(w.is_file() and w.stat().st_size > 0 for w in weights)
    if not ok:
        print("[失败] 预热完成但权重文件缺失或为空（悬空缓存？请重跑）", file=sys.stderr)
        return 5
    # 终局进度行：下载快于轮询周期时，最后一拍可能停在 0.0MB——用实际落盘
    # 体积补一条 100% 行（daemon 侧 appendProgress 原位替换，完成态文案不失真）。
    final_mb = dir_size_mb(target)
    print(f"已下载 {final_mb:.1f}MB / {final_mb:.1f}MB（100%）", flush=True)
    print(f"预热完成：{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
