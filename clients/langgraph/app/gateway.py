"""mcp-foundry 网关的 MCP 客户端封装。

只做一件事：用带身份头的 streamable-http 连上网关，把网关按身份收窄后的工具面
拉成 LangChain 工具交给 agent。工具执行时网关返回结构化 GuardedResult（JSON 文本），
其中 kind=pending 表示高危写被审批闸门挂起——本模块提供识别函数，供上层把它
转成前端的审批态，而不是当成普通工具输出喂回模型。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from .config import GatewayConfig


@dataclass(frozen=True)
class PendingApproval:
    approval_id: str
    rule: str
    raw: dict[str, Any]


def result_text(output: Any) -> str | None:
    """把工具输出归一成文本。langchain-mcp-adapters 的工具返回的是内容块列表
    （[{'type':'text','text':'<GuardedResult JSON>'}]），不是裸字符串——
    这里同时兜住 str / 内容块列表 / 带 .content 的消息对象三种形状。"""
    content = getattr(output, "content", output)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                parts.append(str(block.get("text", "")))
            else:
                parts.append(str(getattr(block, "text", block)))
        return "".join(parts)
    return None


def parse_guarded_result(output: Any) -> dict[str, Any] | None:
    """把工具输出解析成 GuardedResult dict；不是 JSON 或不含 kind 则返回 None。"""
    text = result_text(output)
    if text is None:
        return None
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(obj, dict) and "kind" in obj:
        return obj
    return None


def as_pending(output: Any) -> PendingApproval | None:
    """工具输出若是 kind=pending 的 GuardedResult，取出审批单号；否则 None。"""
    result = parse_guarded_result(output)
    if result is None or result.get("kind") != "pending":
        return None
    approval_id = result.get("approvalId")
    if not isinstance(approval_id, str):
        return None
    return PendingApproval(
        approval_id=approval_id,
        rule=str(result.get("rule", "")),
        raw=result,
    )


async def load_gateway_tools(gateway: GatewayConfig) -> list[BaseTool]:
    """连网关、按当前身份拉取工具面。工具集在 LLM 看到之前就已按身份收窄——
    收窄发生在网关的 tools/list，本客户端拿到的就是收窄后的结果，无需自己过滤。"""
    client = MultiServerMCPClient(
        {
            "foundry": {
                "transport": "streamable_http",
                "url": gateway.url,
                "headers": gateway.headers,
            }
        }
    )
    return await client.get_tools()
