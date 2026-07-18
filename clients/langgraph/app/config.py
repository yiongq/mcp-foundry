"""运行配置：全部从环境变量读，无默认密钥。

身份透传到网关有两条路，与 packages/server 的鉴权模式对齐：
- demo（本地 fixture）：x-foundry-user / x-foundry-role 头，未签名，任何人可声明任何角色
- 生产（token-jwks / token）：Authorization: Bearer <签名令牌>

这个客户端只负责把身份头带上——权限判定、行级过滤、脱敏、审批闸门全在网关里。
换句话说：把 LangGraph 接到同一个网关，它自动获得和飞书 bot 完全相同的安全边界，
一行策略代码都不用在这边写。这正是「守卫做在基础设施层，与 agent 框架无关」的证明。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class GatewayConfig:
    url: str
    headers: dict[str, str]
    identity_label: str


@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    api_key: str
    model: str


@dataclass(frozen=True)
class ApproverConfig:
    """审批人身份：客户端代理 /approvals 决策时用。审批权由网关按域校验
    （角色须标 approver），这里只负责把审批人的身份头带上——同「客户端不做策略」的纪律。
    未配置时前端的审批按钮不可用（pending 仍会显示，只是本 UI 里没法就地批）。"""

    base_url: str
    headers: dict[str, str]
    label: str
    enabled: bool


@dataclass(frozen=True)
class AppConfig:
    gateway: GatewayConfig
    llm: LlmConfig
    approver: ApproverConfig


def gateway_from_env(env: dict[str, str] | None = None) -> GatewayConfig:
    """身份头优先级：Bearer 令牌 > x-foundry-* demo 头。两者都没有则拒绝启动。"""
    env = env if env is not None else dict(os.environ)
    url = env.get("FOUNDRY_MCP_URL", "http://127.0.0.1:3100/mcp")
    token = env.get("FOUNDRY_MCP_TOKEN")
    if token:
        return GatewayConfig(
            url=url,
            headers={"Authorization": f"Bearer {token}"},
            identity_label="signed token (Bearer)",
        )
    user = env.get("FOUNDRY_MCP_USER")
    role = env.get("FOUNDRY_MCP_ROLE")
    if user and role:
        return GatewayConfig(
            url=url,
            headers={"x-foundry-user": user, "x-foundry-role": role},
            identity_label=f"demo headers ({user}/{role})",
        )
    raise RuntimeError(
        "网关身份未配置：设 FOUNDRY_MCP_TOKEN（签名令牌），"
        "或本地 fixture 下设 FOUNDRY_MCP_USER + FOUNDRY_MCP_ROLE（demo 头）。"
    )


def llm_from_env(env: dict[str, str] | None = None) -> LlmConfig:
    """LLM key 在构建 agent 时才强校验——单测/工具加载不需要它，能少一个起服务的门槛。"""
    env = env if env is not None else dict(os.environ)
    return LlmConfig(
        base_url=env.get("FOUNDRY_LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
        api_key=env.get("FOUNDRY_LLM_API_KEY", ""),
        model=env.get("FOUNDRY_LLM_MODEL", "glm-4.6"),
    )


def _gateway_base(mcp_url: str) -> str:
    """从 …/mcp 推出网关根，用于拼 /approvals 端点。"""
    return mcp_url[: -len("/mcp")] if mcp_url.endswith("/mcp") else mcp_url.rstrip("/")


def approver_from_env(env: dict[str, str] | None = None) -> ApproverConfig:
    env = env if env is not None else dict(os.environ)
    base_url = _gateway_base(env.get("FOUNDRY_MCP_URL", "http://127.0.0.1:3100/mcp"))
    token = env.get("FOUNDRY_MCP_APPROVER_TOKEN")
    if token:
        return ApproverConfig(base_url, {"Authorization": f"Bearer {token}"}, "signed token", True)
    user = env.get("FOUNDRY_MCP_APPROVER_USER")
    role = env.get("FOUNDRY_MCP_APPROVER_ROLE")
    if user and role:
        return ApproverConfig(
            base_url,
            {"x-foundry-user": user, "x-foundry-role": role},
            f"demo headers ({user}/{role})",
            True,
        )
    return ApproverConfig(base_url, {}, "未配置", False)


def load_config() -> AppConfig:
    return AppConfig(
        gateway=gateway_from_env(),
        llm=llm_from_env(),
        approver=approver_from_env(),
    )
