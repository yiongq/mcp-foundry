"""审批决策的薄代理：把前端的看单/批单转发到网关的 /approvals 端点。

审批权判定在网关（角色须标 approver，按域裁决）——这里只透传审批人身份头。
这样 LangGraph 这个 UI 里就能就地完成「pending → 批准 → 续跑」的完整回路，
无需另开飞书，也就能录进演示视频；同时证明审批端点与 agent 框架无关。
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import ApproverConfig


class ApprovalsProxy:
    def __init__(self, approver: ApproverConfig) -> None:
        self._approver = approver

    @property
    def enabled(self) -> bool:
        return self._approver.enabled

    async def list_pending(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{self._approver.base_url}/approvals",
                headers=self._approver.headers,
            )
            resp.raise_for_status()
            return resp.json().get("approvals", [])

    async def decide(self, approval_id: str, decision: str) -> tuple[int, dict[str, Any]]:
        """decision ∈ {approve, deny}。返回网关的 (status_code, body)——
        409/403/404 等原样透传给前端，让 UI 如实反映（已批过/无权/不存在）。"""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{self._approver.base_url}/approvals/{approval_id}",
                headers={**self._approver.headers, "content-type": "application/json"},
                json={"decision": decision},
            )
            try:
                body = resp.json()
            except ValueError:
                body = {"error": "网关返回非 JSON"}
            return resp.status_code, body
