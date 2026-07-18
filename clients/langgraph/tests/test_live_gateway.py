"""与真实网关的集成测试：默认跳过（需要本地起 fixture 网关）。

  # 终端 A：起网关（headers 模式）
  pnpm --filter @yiong/foundry-server serve
  # 终端 B：
  FOUNDRY_TEST_LIVE=1 .venv/bin/python -m pytest tests/test_live_gateway.py -v

验证的是最吃劲的集成点——LangGraph 经 langchain-mcp-adapters 连同一个网关，
拿到按身份收窄的工具面、写操作被闸门挂起、批准后同参重试消票执行、跨主写被写前拦。
这段无需 LLM，纯工具层就能把 HITL 闭环走完。
"""

import os

import pytest

from app.approvals import ApprovalsProxy
from app.config import ApproverConfig, GatewayConfig
from app.gateway import as_pending, load_gateway_tools, parse_guarded_result

LIVE = os.environ.get("FOUNDRY_TEST_LIVE") == "1"
GATEWAY_URL = os.environ.get("FOUNDRY_MCP_URL", "http://127.0.0.1:3100/mcp")
pytestmark = pytest.mark.skipif(not LIVE, reason="需 FOUNDRY_TEST_LIVE=1 且本地网关已启动")


def _rep() -> GatewayConfig:
    return GatewayConfig(
        GATEWAY_URL, {"x-foundry-user": "e007", "x-foundry-role": "sales_rep"}, "demo"
    )


def _manager_proxy() -> ApprovalsProxy:
    base = GATEWAY_URL[: -len("/mcp")] if GATEWAY_URL.endswith("/mcp") else GATEWAY_URL
    return ApprovalsProxy(
        ApproverConfig(
            base, {"x-foundry-user": "e005", "x-foundry-role": "sales_manager"}, "demo", True
        )
    )


async def test_identity_narrowed_toolface():
    rep_tools = {t.name for t in await load_gateway_tools(_rep())}
    # sales_rep：6 读 + 4 写；不含全员业绩盘
    assert "delete_contact" in rep_tools
    assert "create_contact" in rep_tools
    assert "get_pipeline_summary" not in rep_tools

    emp = GatewayConfig(
        GATEWAY_URL, {"x-foundry-user": "e002", "x-foundry-role": "employee"}, "demo"
    )
    emp_tools = {t.name for t in await load_gateway_tools(emp)}
    # 跨域：HR 员工看不到任何 CRM 工具
    assert "get_leave_balance" in emp_tools
    assert emp_tools.isdisjoint(rep_tools)


async def test_full_hitl_loop():
    tools = {t.name: t for t in await load_gateway_tools(_rep())}
    delete = tools["delete_contact"]

    # 自己的联系人 → pending
    pending = as_pending(await delete.ainvoke({"contact_id": "c005"}))
    assert pending is not None

    # 经理批准 → 同参重试消票执行
    proxy = _manager_proxy()
    status, body = await proxy.decide(pending.approval_id, "approve")
    assert status == 200 and body["status"] == "approved"
    resumed = parse_guarded_result(await delete.ainvoke({"contact_id": "c005"}))
    assert resumed["kind"] == "ok"


async def test_cross_owner_write_denied_before_execute():
    tools = {t.name: t for t in await load_gateway_tools(_rep())}
    # c003 归属 e008——写前行级归属校验拦下，不 pending 不执行
    result = parse_guarded_result(await tools["delete_contact"].ainvoke({"contact_id": "c003"}))
    assert result["kind"] == "refusal"
    assert result["reason"] == "row_denied"
