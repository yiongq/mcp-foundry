"""身份配置：Bearer 令牌优先于 demo 头；两者都缺则拒绝启动（fail-loud）。
审批人身份缺失则就地批复关闭（enabled=False），但服务照常起。"""

import base64
import json

import pytest

from app.config import (
    approver_from_env,
    gateway_from_env,
    llm_from_env,
    load_config,
    manager_gateway_from_env,
)


def _es256_token(sub: str, role: str) -> str:
    """构造一枚仅供展示解析的 JWT（签名段随便填，客户端不验签）。"""

    def seg(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{seg({'alg': 'ES256', 'kid': 'k'})}.{seg({'sub': sub, 'role': role})}.sig"


def test_gateway_prefers_bearer_token_over_demo_headers():
    gw = gateway_from_env(
        {
            "FOUNDRY_MCP_URL": "https://foundry.example.com/mcp",
            "FOUNDRY_MCP_TOKEN": "tok123",
            "FOUNDRY_MCP_USER": "e007",
            "FOUNDRY_MCP_ROLE": "sales_rep",
        }
    )
    assert gw.headers == {"Authorization": "Bearer tok123"}
    assert "x-foundry-user" not in gw.headers  # 令牌模式下 demo 头被忽略


def test_gateway_demo_headers_when_no_token():
    gw = gateway_from_env({"FOUNDRY_MCP_USER": "e007", "FOUNDRY_MCP_ROLE": "sales_rep"})
    assert gw.headers == {"x-foundry-user": "e007", "x-foundry-role": "sales_rep"}


def test_gateway_no_identity_raises():
    with pytest.raises(RuntimeError, match="网关身份未配置"):
        gateway_from_env({"FOUNDRY_MCP_URL": "http://x/mcp"})


def test_approver_base_url_derived_from_mcp_url():
    ap = approver_from_env(
        {
            "FOUNDRY_MCP_URL": "https://foundry.example.com/mcp",
            "FOUNDRY_MCP_APPROVER_USER": "e005",
            "FOUNDRY_MCP_APPROVER_ROLE": "sales_manager",
        }
    )
    assert ap.enabled is True
    assert ap.base_url == "https://foundry.example.com"  # /mcp 被剥掉
    assert ap.headers["x-foundry-role"] == "sales_manager"


def test_approver_disabled_when_unconfigured():
    ap = approver_from_env({"FOUNDRY_MCP_URL": "http://127.0.0.1:3100/mcp"})
    assert ap.enabled is False
    assert ap.headers == {}


def test_llm_defaults_do_not_require_key():
    llm = llm_from_env({})  # 缺 key 不抛——构建 agent 时才强校验
    assert llm.model == "glm-4.6"
    assert llm.api_key == ""


def test_gateway_label_and_name_decoded_from_token():
    gw = gateway_from_env({"FOUNDRY_MCP_TOKEN": _es256_token("e007", "sales_rep")})
    assert gw.name == "林哲"  # e007 → 名字表
    assert gw.role == "sales_rep"
    assert gw.user_id == "e007"
    assert gw.token_alg == "ES256"
    assert gw.identity_label == "林哲 · sales_rep"


def test_gateway_name_env_overrides_default():
    gw = gateway_from_env(
        {"FOUNDRY_MCP_USER": "e007", "FOUNDRY_MCP_ROLE": "sales_rep", "FOUNDRY_MCP_NAME": "孙七"}
    )
    assert gw.name == "孙七"
    assert gw.token_alg == "demo 头(未签名)"


def test_manager_identity_none_when_unconfigured():
    assert manager_gateway_from_env({"FOUNDRY_MCP_USER": "e007", "FOUNDRY_MCP_ROLE": "sales_rep"}) is None


def test_manager_identity_from_demo_headers():
    mgr = manager_gateway_from_env(
        {"FOUNDRY_MCP_MANAGER_USER": "e005", "FOUNDRY_MCP_MANAGER_ROLE": "sales_manager_ro"}
    )
    assert mgr is not None
    assert mgr.key == "manager"
    assert mgr.role == "sales_manager_ro"
    assert mgr.name == "何静"
    assert mgr.headers == {"x-foundry-user": "e005", "x-foundry-role": "sales_manager_ro"}


def test_load_config_includes_manager_only_when_configured(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith("FOUNDRY_MCP"):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("FOUNDRY_MCP_USER", "e007")
    monkeypatch.setenv("FOUNDRY_MCP_ROLE", "sales_rep")
    cfg_one = load_config()
    assert list(cfg_one.identities) == ["rep"]
    assert cfg_one.default_identity == "rep"

    monkeypatch.setenv("FOUNDRY_MCP_MANAGER_USER", "e005")
    monkeypatch.setenv("FOUNDRY_MCP_MANAGER_ROLE", "sales_manager_ro")
    cfg_two = load_config()
    assert list(cfg_two.identities) == ["rep", "manager"]
