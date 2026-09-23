"""向导 whisper 预热（走查四轮，2026-09-25；五轮重写 2026-09-26）。

把管线真正使用的 mlx-whisper 模型（mlx-community/whisper-*）预取到 HF 标准
缓存。五轮起不再经 huggingface_hub 的 snapshot_download 下载——1.x 已移除
跨会话续传（临时文件名含随机会话后缀、失败即删，源码注释原话 "could not be
reused anyway"），「恢复下载」语义在它上层不存在；且 xet 路径字节进独立分块
缓存、CAS 端点绕过 HF_ENDPOINT 镜像。

改为自管下载器，写回与 hf_hub 完全同构的缓存布局（读侧只校验文件存在性，
手工布局合法）：
    blobs/<lfs.oid 或 git blob_id>        权重/文件实体（LFS=sha256，其他=sha1）
    blobs/<oid>.download                  断点残差（固定名，Range 续传基数）
    snapshots/<commit>/<file>             软链 → ../../blobs/<oid>
    refs/main                             commit 哈希文本

收养机制：hf_hub 旧会话残留的 `<oid>.<8hex>.incomplete` 孤儿（同 oid 前缀
合法）改名为 `.download` 继续续传——不浪费已被杀掉会话的字节。

输出协议与向导日志对齐：「已下载 X.XMB / Y.YMB（Z%）」为进度行（原位替换）。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable

DEFAULT_ENDPOINT = "https://huggingface.co"
CHUNK = 1024 * 256
RETRIES = 5


def hub_root() -> Path:
    hf_home = os.environ.get("HF_HOME")
    return Path(hf_home) if hf_home else Path.home() / ".cache" / "huggingface"


def cache_repo_dir(repo: str) -> Path:
    return hub_root() / "hub" / ("models--" + repo.replace("/", "--"))


class FileSpec:
    def __init__(self, name: str, blob_name: str, size: int, is_lfs: bool) -> None:
        self.name = name
        self.blob_name = blob_name
        self.size = size
        self.is_lfs = is_lfs


def list_repo_files(endpoint: str, repo: str) -> tuple[str, list[FileSpec]]:
    """仓库元数据（files_metadata）：commit + 每文件 blob 名与体积。

    blob 命名对齐 hf_hub：LFS 文件用 lfs.oid（sha256），其余用 git blob_id
    （sha1）——实测两种缓存名均如此。
    """
    from huggingface_hub import HfApi  # 仅用元数据 API，不用于下载

    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    info = None
    for attempt in range(1, RETRIES + 1):
        try:
            info = HfApi(endpoint=endpoint).model_info(repo, files_metadata=True)
            break
        except Exception:  # noqa: BLE001 - 镜像 SSL 瞬断等，退避重试
            if attempt == RETRIES:
                raise
            time.sleep(min(2**attempt, 30))
    specs: list[FileSpec] = []
    for sib in info.siblings or []:
        if sib.rfilename.endswith("/"):  # 目录占位
            continue
        if sib.lfs is not None:
            # BlobLfsInfo 字段为 sha256（实测即缓存 blobs/<名>）
            specs.append(FileSpec(sib.rfilename, sib.lfs.sha256, sib.lfs.size or 0, True))
        else:
            specs.append(FileSpec(sib.rfilename, sib.blob_id or "", sib.size or 0, False))
    return str(info.sha), specs


def blob_complete(blobs: Path, spec: FileSpec) -> bool:
    f = blobs / spec.blob_name
    return spec.blob_name != "" and f.exists() and (spec.size == 0 or f.stat().st_size == spec.size)


def adopt_orphans(blobs: Path, specs: list[FileSpec]) -> int:
    """收养 hf_hub 旧会话残留（<oid>.<8hex>.incomplete）为 .download 残差。"""
    adopted = 0
    for tmp in list(blobs.glob("*.incomplete")):
        stem = tmp.name[: -len(".incomplete")]
        oid, _, sess = stem.rpartition(".")
        if len(sess) != 8 or len(oid) < 8:
            continue  # 非 hf 会话命名，不动
        for spec in specs:
            if spec.blob_name == oid and spec.size > 0:
                dest = blobs / f"{spec.blob_name}.download"
                size = min(tmp.stat().st_size, spec.size)  # 超长截断（脏尾保护）
                with tmp.open("rb") as src, dest.open("wb") as out:
                    left = size
                    while left > 0:
                        buf = src.read(min(CHUNK, left))
                        if not buf:
                            break
                        out.write(buf)
                        left -= len(buf)
                tmp.unlink(missing_ok=True)
                adopted += 1
                print(f"收养历史残差：{oid[:12]}…（{size / 1024 / 1024:.1f}MB）", flush=True)
                break
    return adopted


def download_one(
    endpoint: str,
    repo: str,
    commit: str,
    spec: FileSpec,
    blobs: Path,
    on_bytes: Callable[[int], None],
) -> None:
    """单文件下载：固定名 .download + Range 续传 + 完整性校验 + 原子落位。"""
    url = f"{endpoint}/{repo}/resolve/{commit}/{spec.name}"
    tmp = blobs / f"{spec.blob_name}.download"
    last_error: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            pos = tmp.stat().st_size if tmp.exists() else 0
            if pos > spec.size:
                tmp.unlink()  # 残差脏尾（超期望体积）
                pos = 0
            headers = {"Range": f"bytes={pos}-"} if pos > 0 else {}
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                if pos > 0 and resp.status != 206:
                    # 服务端不认 Range → 从头覆盖
                    tmp.unlink()
                    pos = 0
                mode = "ab" if pos > 0 else "wb"
                with tmp.open(mode) as out:
                    while True:
                        buf = resp.read(CHUNK)
                        if not buf:
                            break
                        out.write(buf)
                        on_bytes(len(buf))
                        out.flush()
            got = tmp.stat().st_size
            if got != spec.size:
                raise IOError(f"体积不符：期望 {spec.size}，实得 {got}")
            verify_and_move(tmp, blobs / spec.blob_name, spec)
            return
        except Exception as exc:  # noqa: BLE001 - 重试语义统一收口
            last_error = exc
            time.sleep(min(2**attempt, 30))
    raise RuntimeError(f"下载失败（{RETRIES} 次重试后）：{spec.name}：{last_error}")


def verify_and_move(tmp: Path, dest: Path, spec: FileSpec) -> None:
    """完整性校验（LFS=sha256 全量；git 文件=sha1("blob <size>\\0"+content)）后原子落位。"""
    if spec.is_lfs:
        h = hashlib.sha256()
        with tmp.open("rb") as f:
            while True:
                buf = f.read(1024 * 1024)
                if not buf:
                    break
                h.update(buf)
        if h.hexdigest() != spec.blob_name:
            raise IOError(f"sha256 校验失败：{spec.name}")
    else:
        h = hashlib.sha1()
        h.update(f"blob {spec.size}\0".encode())
        with tmp.open("rb") as f:
            while True:
                buf = f.read(1024 * 1024)
                if not buf:
                    break
                h.update(buf)
        if h.hexdigest() != spec.blob_name:
            raise IOError(f"git blob sha1 校验失败：{spec.name}")
    os.replace(tmp, dest)


def link_snapshot(cache: Path, commit: str, spec: FileSpec, blobs: Path) -> None:
    snap = cache / "snapshots" / commit / spec.name
    snap.parent.mkdir(parents=True, exist_ok=True)
    if snap.is_symlink() or snap.exists():
        snap.unlink()
    snap.symlink_to(os.path.relpath(blobs / spec.blob_name, snap.parent))


def dir_size_bytes(path: Path) -> int:
    """目录体积（字节）。跳过符号链接——snapshots 里是 blobs 的软链，不跳会双计。"""
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


def main() -> int:
    ap = argparse.ArgumentParser(description="预热 mlx-whisper 模型到 HF 缓存（自管断点续传）")
    ap.add_argument("--repo", required=True, help="HF 仓库（如 mlx-community/whisper-tiny）")
    ap.add_argument("--endpoint", default="", help="镜像端点（默认官方）")
    ap.add_argument("--force", action="store_true", help="覆盖下载：清除该仓库缓存从头下载")
    args = ap.parse_args()

    endpoint = args.endpoint or DEFAULT_ENDPOINT
    if endpoint != DEFAULT_ENDPOINT:
        os.environ["HF_ENDPOINT"] = endpoint
        print(f"镜像端点：{endpoint}")

    try:
        from huggingface_hub import HfApi  # noqa: F401 - 探测依赖可用性
    except ImportError:
        print("[失败] huggingface_hub 未安装（uv sync --extra transcribe）", file=sys.stderr)
        return 3

    cache = cache_repo_dir(args.repo)
    blobs = cache / "blobs"
    if args.force and cache.exists():
        shutil.rmtree(cache)
        print(f"已清除旧缓存：{cache}")
    blobs.mkdir(parents=True, exist_ok=True)

    try:
        commit, specs = list_repo_files(endpoint, args.repo)
    except Exception as exc:  # noqa: BLE001
        print(f"[失败] 仓库元数据获取失败：{exc}", file=sys.stderr)
        return 4
    if not any(s.is_lfs for s in specs):
        print("[失败] 仓库不含权重文件（lfs），请确认型号", file=sys.stderr)
        return 4

    adopt_orphans(blobs, specs)

    todo = [s for s in specs if s.blob_name and not blob_complete(blobs, s)]
    residue = sum(p.stat().st_size for p in blobs.glob("*.download"))
    print(
        f"待下载 {len(todo)} 个文件 / {sum(s.size for s in todo) / 1024 / 1024:.1f}MB"
        f"（含可续传残差 {residue / 1024 / 1024:.1f}MB）",
        flush=True,
    )
    for s in specs:
        if not s.blob_name:
            print(f"跳过无 blob 标识的文件：{s.name}", flush=True)
    total = sum(s.size for s in todo)
    done_bytes = 0
    lock = threading.Lock()

    def on_bytes(n: int) -> None:
        nonlocal done_bytes
        with lock:
            done_bytes += n

    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            time.sleep(2)
            with lock:
                done = done_bytes
            # 起跑基数：既存 .download 残差（收养/上次中断）计入已完成。
            base = sum(p.stat().st_size for p in blobs.glob("*.download"))
            mb = (done + base) / 1024 / 1024
            total_mb = total / 1024 / 1024
            if total_mb > 0:
                pct = min(100, round((done + base) / total * 100))
                print(f"已下载 {mb:.1f}MB / {total_mb:.1f}MB（{pct}%）", flush=True)
            else:
                print("已全部就绪", flush=True)

    watcher = threading.Thread(target=poll, daemon=True)
    watcher.start()
    try:
        for spec in todo:
            download_one(endpoint, args.repo, commit, spec, blobs, on_bytes)
    except Exception as exc:  # noqa: BLE001
        stop.set()
        print(f"[失败] {exc}", file=sys.stderr)
        return 5
    stop.set()
    watcher.join(timeout=3)
    # 软链无条件全量重建（实证 bug：blob 齐但 snapshots 被清时 todo 为空，
    # 原实现不补链直接在自检崩——「已下载却不可用」）。
    for spec in specs:
        if spec.blob_name and blob_complete(blobs, spec):
            link_snapshot(cache, commit, spec, blobs)

    # refs/main + 完成自检（权重软链必须解析到非空真实文件）。
    refs = cache / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text(commit)
    snap_dir = cache / "snapshots" / commit
    weights = [p for p in snap_dir.iterdir() if p.name.endswith((".safetensors", ".npz"))]
    if not weights or not all(w.is_file() and w.stat().st_size > 0 for w in weights):
        print("[失败] 预热完成但权重文件缺失或为空（悬空缓存？请重跑）", file=sys.stderr)
        return 6

    final_mb = dir_size_bytes(cache) / 1024 / 1024
    print(f"已下载 {final_mb:.1f}MB / {final_mb:.1f}MB（100%）", flush=True)
    print(f"预热完成：{snap_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
