"""运行入口：`python -m app`。装载 .env 后起 uvicorn。

配置策略（回答「密钥 copy 一份还是统一维护」）：
- 本地开发：共享密钥（FOUNDRY_LLM_*）放**仓库根 .env** 一处维护，客户端专属配置
  （FOUNDRY_MCP_*）放本目录 .env。装载顺序 = 先本地、后根、真实环境变量最优先，
  于是本地能覆盖根、根做共享兜底、命令行 export 能临时压过一切——不必到处 copy 同一个 key。
- 部署：各服务本就跑在不同容器/机器，无法共享文件，届时各自用环境变量注入（同一优先级链）。
极简装载（KEY=VALUE 逐行，不引 python-dotenv），和 packages/feishu 的 loadDotEnv 一个姿势。
"""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn


def load_dotenv(path: Path) -> None:
    """把文件里尚未在环境中的 KEY=VALUE 注入。已存在的不覆盖——
    先调用者（本地 .env / 真实环境变量）优先，后调用者（根 .env）只做兜底。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


def main() -> None:
    client_dir = Path(__file__).resolve().parent.parent
    repo_root = client_dir.parent.parent
    load_dotenv(client_dir / ".env")  # 客户端专属 + 覆盖
    load_dotenv(repo_root / ".env")  # 仓库根共享密钥兜底（如 FOUNDRY_LLM_*）
    port = int(os.environ.get("PORT", "8100"))
    uvicorn.run("app.server:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
