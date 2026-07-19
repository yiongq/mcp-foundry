"""运行配置：全部从环境变量读，无默认密钥。

身份透传到网关有两条路，与 packages/server 的鉴权模式对齐：
- demo（本地 fixture）：x-foundry-user / x-foundry-role 头，未签名，任何人可声明任何角色
- 生产（token-jwks / token）：Authorization: Bearer <签名令牌>

这个客户端只负责把身份头带上——权限判定、行级过滤、脱敏、审批闸门全在网关里。
换句话说：把 LangGraph 接到同一个网关，它自动获得和飞书 bot 完全相同的安全边界，
一行策略代码都不用在这边写。这正是「守卫做在基础设施层，与 agent 框架无关」的证明。

演示身份（可切换）：
- 默认身份「rep」= FOUNDRY_MCP_TOKEN（或 FOUNDRY_MCP_USER/ROLE），线上 = 林哲 sales_rep。
- 可选身份「manager」= FOUNDRY_MCP_MANAGER_TOKEN（或 *_MANAGER_USER/ROLE）。约定它是**只读**经理
  （role=sales_manager_ro，见 config/rbac.twenty.yaml）——工具面更宽但无写、非 approver，
  这样公开页放这枚令牌也安全：访客切到经理也改不了数据、批不了单。缺省即不提供该身份，
  前端的身份段控随之隐藏（只剩单一销售身份）。
"""

from __future__ import annotations

import base64
import binascii
import json
import os
from dataclasses import dataclass

# userId → 展示名（与 packages/adapter-twenty 的 FIXTURE_OWNERS / get_pipeline_summary 的
# owner_name 对齐——身份卡上的名字要和盘点表里出现的负责人名字是同一个人，别对不上）。
# 可被 FOUNDRY_MCP_NAME / FOUNDRY_MCP_MANAGER_NAME 覆盖。
_DEFAULT_NAMES: dict[str, str] = {"e005": "何静", "e007": "林哲", "e008": "罗宁"}


@dataclass(frozen=True)
class GatewayConfig:
    url: str
    headers: dict[str, str]
    identity_label: str
    # 供前端身份卡 / 段控展示（不参与鉴权，鉴权全在网关）
    key: str = "rep"  # "rep" | "manager"
    name: str = ""  # 展示名，如 林哲
    role: str = ""  # sales_rep | sales_manager_ro
    user_id: str = ""  # e007
    token_alg: str = ""  # 令牌头自述的 alg（ES256/HS256/RS256），或 "demo 头"


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
    identities: dict[str, GatewayConfig]  # 有序：{"rep": ..., ["manager": ...]}，第一个为默认
    default_identity: str
    llm: LlmConfig
    approver: ApproverConfig


def _b64url_json(segment: str) -> dict[str, object]:
    """解一段 base64url JSON（JWT 的 header/payload）。仅用于展示，不验签——
    验签是网关的事，这里读错读空都无所谓（回退到空 dict）。"""
    try:
        padded = segment + "=" * (-len(segment) % 4)
        obj = json.loads(base64.urlsafe_b64decode(padded))
        return obj if isinstance(obj, dict) else {}
    except (ValueError, binascii.Error, json.JSONDecodeError, TypeError):
        return {}


def _identity_from_env(
    env: dict[str, str],
    *,
    key: str,
    token_var: str,
    user_var: str,
    role_var: str,
    name_var: str,
    default_role: str,
    url: str,
) -> GatewayConfig | None:
    """按 token > demo 头的优先级构造一枚身份；都没配则 None（供可选身份用）。
    展示用的 name/role/userId/alg：令牌模式从 JWT 里读（不验签），demo 头模式直接取头。"""
    token = env.get(token_var)
    if token:
        parts = token.split(".")
        header = _b64url_json(parts[0]) if len(parts) == 3 else {}
        claims = _b64url_json(parts[1]) if len(parts) == 3 else {}
        user_id = str(claims.get("sub", ""))
        role = str(claims.get("role", "")) or default_role
        alg = str(header.get("alg", "")) or "signed"
        headers = {"Authorization": f"Bearer {token}"}
    else:
        user_id = env.get(user_var, "")
        role = env.get(role_var, "") or default_role
        if not (user_id and env.get(role_var, "")):
            return None
        alg = "demo 头(未签名)"
        headers = {"x-foundry-user": user_id, "x-foundry-role": role}
    name = env.get(name_var) or _DEFAULT_NAMES.get(user_id) or user_id or "身份"
    return GatewayConfig(
        url=url,
        headers=headers,
        identity_label=f"{name} · {role}",
        key=key,
        name=name,
        role=role,
        user_id=user_id,
        token_alg=alg,
    )


def gateway_from_env(env: dict[str, str] | None = None) -> GatewayConfig:
    """默认（销售）身份。身份头优先级：Bearer 令牌 > x-foundry-* demo 头。两者都没有则拒绝启动。"""
    env = env if env is not None else dict(os.environ)
    url = env.get("FOUNDRY_MCP_URL", "http://127.0.0.1:3100/mcp")
    gw = _identity_from_env(
        env,
        key="rep",
        token_var="FOUNDRY_MCP_TOKEN",
        user_var="FOUNDRY_MCP_USER",
        role_var="FOUNDRY_MCP_ROLE",
        name_var="FOUNDRY_MCP_NAME",
        default_role="sales_rep",
        url=url,
    )
    if gw is None:
        raise RuntimeError(
            "网关身份未配置：设 FOUNDRY_MCP_TOKEN（签名令牌），"
            "或本地 fixture 下设 FOUNDRY_MCP_USER + FOUNDRY_MCP_ROLE（demo 头）。"
        )
    return gw


def manager_gateway_from_env(env: dict[str, str] | None = None) -> GatewayConfig | None:
    """可选的「只读经理」演示身份。没配就 None（前端段控随之隐藏）。
    约定 role=sales_manager_ro：工具面更宽但无写工具、非 approver——公开页可安全提供。"""
    env = env if env is not None else dict(os.environ)
    url = env.get("FOUNDRY_MCP_URL", "http://127.0.0.1:3100/mcp")
    return _identity_from_env(
        env,
        key="manager",
        token_var="FOUNDRY_MCP_MANAGER_TOKEN",
        user_var="FOUNDRY_MCP_MANAGER_USER",
        role_var="FOUNDRY_MCP_MANAGER_ROLE",
        name_var="FOUNDRY_MCP_MANAGER_NAME",
        default_role="sales_manager_ro",
        url=url,
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
    env = dict(os.environ)
    identities: dict[str, GatewayConfig] = {"rep": gateway_from_env(env)}
    manager = manager_gateway_from_env(env)
    if manager is not None:
        identities["manager"] = manager
    return AppConfig(
        identities=identities,
        default_identity="rep",
        llm=llm_from_env(env),
        approver=approver_from_env(env),
    )
