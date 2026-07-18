"""身份配置：Bearer 令牌优先于 demo 头；两者都缺则拒绝启动（fail-loud）。
审批人身份缺失则就地批复关闭（enabled=False），但服务照常起。"""

import pytest

from app.config import approver_from_env, gateway_from_env, llm_from_env


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
