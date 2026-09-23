"""python -m shufa_tool 入口：等价于 python -m shufa_tool.steps（离散步骤命令行）。

意图（2026-09-22，W6）：产品 daemon 以 `uv run python -m shufa_tool.steps <step>`
调用分析管线；本模块让 `python -m shufa_tool` 也能到达同一入口。
"""

from .steps import main

if __name__ == "__main__":
    main()
