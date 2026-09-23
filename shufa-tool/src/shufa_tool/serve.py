"""分析包承载：Vite 构建静态站点 + 纯静态 HTTP 服务。

意图（2026-09-22，Owner 澄清"只是用 vite 来开发，到时候直接编译出 html"）：
Vite 只用于开发期；正式产物 = `vite build` 编译出的静态网页（index.html + JS/CSS
+ 分析包资产）。数据契约 = data.json（类型定义在 web/src/types.ts）。
流程：shufa-serve → 以 SHUFA_DATA=bundle 执行 npm run build（publicDir 注入，
包内容烤进 dist）→ dist 上起 Python http.server（查看期零 Node 依赖）。
构建有缓存：bundle 路径与 data.json mtime 未变则跳过。--dev 切换 vite dev。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import subprocess
import webbrowser
from pathlib import Path

DEFAULT_PORT = 6173


def web_dir() -> Path:
    """定位前端工程：优先环境变量 SHUFA_WEB，其次包仓库的 web/（serve.py 位于
    <repo>/src/shufa_tool/，向上三级即仓库根），最后当前目录的 web/。"""
    here = Path(__file__).resolve()
    for cand in (os.environ.get("SHUFA_WEB"),
                 here.parent.parent.parent / "web",
                 here.parent / "web",
                 Path.cwd() / "web"):
        if cand and (Path(cand) / "package.json").exists():
            return Path(cand)
    raise RuntimeError(
        "未找到前端工程 web/（应含 package.json）。"
        "可设置 SHUFA_WEB 指向前端工程目录。")


def _ensure_deps(web: Path) -> None:
    if (web / "node_modules").is_dir():
        return
    print("[serve] web/ 依赖缺失，执行 npm install（首次较慢）…")
    subprocess.run(["npm", "install"], cwd=web, check=True)


def _build(web: Path, bundle: Path, force: bool = False) -> Path:
    """npm run build（SHUFA_DATA 注入 publicDir）。带缓存：包未变跳过。"""
    dist = web / "dist"
    stamp = dist / ".shufa-stamp"
    sig = json.dumps({"bundle": str(bundle),
                      "mtime": (bundle / "data.json").stat().st_mtime_ns})
    if not force and stamp.is_file() and stamp.read_text() == sig:
        print(f"[serve] 复用已构建 dist（bundle 未变化）")
        return dist
    _ensure_deps(web)
    env = {**os.environ, "SHUFA_DATA": str(bundle)}
    print(f"[serve] 构建静态站点（bundle: {bundle}）…")
    subprocess.run(["npm", "run", "build"], cwd=web, env=env, check=True)
    dist.mkdir(parents=True, exist_ok=True)
    stamp.write_text(sig)
    return dist


class _RangeHandler(http.server.SimpleHTTPRequestHandler):
    """支持 Range 请求的静态处理器：视频 seek 依赖 206 分段响应，
    SimpleHTTP 原生不支持会导致播放器在部分浏览器上无法跳转。"""

    def send_head(self):  # noqa: D102 — 复制父类取文件部分，range 命中走 206
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            fs = os.fstat(f.fileno())
            size = fs.st_size
            rng = self.headers.get("Range")
            if rng:
                import re
                m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
                if m and (m.group(1) or m.group(2)):
                    start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
                    end = int(m.group(2)) if m.group(2) else size - 1
                    start, end = max(0, start), min(end, size - 1)
                    if start > end:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        f.close()
                        return None
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.send_header("Content-Type", self.guess_type(path))
                    self.end_headers()
                    f.seek(start)
                    self._range_remaining = end - start + 1
                    # 复制循环由 copyfile 承担，这里包裹 f 限制读取长度
                    return _LimitedFile(f, end - start + 1)
            self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Type", self.guess_type(path))
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise

    def log_message(self, *args) -> None:  # 静默访问日志，保持 CLI 输出干净
        pass


class _LimitedFile:
    """只读游标：把文件读取限制在 Range 长度内（供 shutil.copyfileobj 使用）。"""

    def __init__(self, f, remaining: int) -> None:
        self._f, self._remaining = f, remaining

    def read(self, size: int = -1) -> bytes:
        n = self._remaining if size < 0 else min(size, self._remaining)
        data = self._f.read(n)
        self._remaining -= len(data)
        return data

    def close(self) -> None:
        self._f.close()


def _serve_static(dist: Path, port: int, open_browser: bool) -> None:
    """dist 上的纯静态服务（查看期零 Node 依赖，支持 Range 视频跳转）。"""
    handler = functools.partial(_RangeHandler, directory=str(dist))
    url = f"http://localhost:{port}/"
    print(f"[serve] {url}  （dist: {dist}）  Ctrl-C 停止")
    if open_browser:
        webbrowser.open(url)
    try:
        http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] 已停止")


def serve_bundle(bundle: Path, port: int = DEFAULT_PORT,
                 open_browser: bool = True, dev: bool = False) -> None:
    """承载分析包：默认构建+静态服务；dev=True 走 vite dev（开发调试）。"""
    bundle = bundle.resolve()
    if not (bundle / "data.json").is_file():
        raise RuntimeError(f"分析包无效：{bundle} 缺少 data.json")
    web = web_dir()
    if dev:
        _ensure_deps(web)
        env = {**os.environ, "SHUFA_DATA": str(bundle)}
        url = f"http://localhost:{port}/"
        print(f"[serve] vite dev: {url}  （bundle: {bundle}）  Ctrl-C 停止")
        if open_browser:
            webbrowser.open(url)
        try:
            subprocess.run(["npm", "run", "dev", "--", "--port", str(port),
                            "--strictPort"], cwd=web, env=env, check=True)
        except KeyboardInterrupt:
            print("\n[serve] 已停止")
        return
    dist = _build(web, bundle)
    _serve_static(dist, port, open_browser)


def serve_bundle_main() -> None:
    """shufa-serve 入口：独立承载已有分析包。"""
    ap = argparse.ArgumentParser(prog="shufa-serve", description="构建并承载分析包")
    ap.add_argument("bundle", type=Path, nargs="?", default=None,
                    help="分析包目录（缺 data.json 时报错）；省略时取最近一次分析的工作包")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--dev", action="store_true", help="vite dev 模式（前端开发调试）")
    args = ap.parse_args()
    bundle = args.bundle
    if bundle is None:
        import subprocess as sp
        latest = sp.run(
            ["bash", "-lc",
             "ls -dt */.shufa-work/*/bundle 2>/dev/null .shufa-work/*/bundle 2>/dev/null | head -1"],
            capture_output=True, text=True,
        ).stdout.strip()
        if not latest:
            raise SystemExit("未指定分析包，且当前目录找不到 .shufa-work/*/bundle")
        bundle = Path(latest)
    serve_bundle(bundle, port=args.port, open_browser=not args.no_open, dev=args.dev)
