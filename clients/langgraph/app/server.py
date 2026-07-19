"""FastAPI 入口：SSE 流式对话 + 审批代理 + 自建前端托管。

对话走 LangGraph react agent 的 astream_events，映射成前端好消费的事件流：
token 增量、工具开始/结束、pending 审批态、完成。审批闸门的 pending 不当普通
工具输出，单独发一条 pending 事件，让前端就地弹审批卡片。

多身份：每枚演示身份（rep / 可选 manager）各自连网关、各自把网关按身份收窄后的工具面
装成一个 agent。/api/chat 按请求里的 identity 选用对应 agent——工具面/行级/脱敏的差异
全是网关给的真实结果，不是前端演的。thread_id 按身份加前缀，切身份即换一段对话。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.memory import MemorySaver
from sse_starlette.sse import EventSourceResponse

from .agent import build_agent, build_chat_model
from .approvals import ApprovalsProxy
from .config import AppConfig, GatewayConfig, load_config
from .gateway import as_pending, load_gateway_tools, parse_guarded_result

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class IdentityRuntime:
    """一枚演示身份的运行态：网关配置元信息、按该身份收窄的工具表、绑定这套工具的 agent。
    agent 可能为 None（缺 LLM 凭据）——此时页面/身份信息/工具面仍可用，只有对话返回明确提示。"""

    def __init__(self, meta: GatewayConfig, agent: Any, tools: dict[str, Any]) -> None:
        self.meta = meta
        self.agent = agent
        self.tools = tools


class Runtime:
    """进程级共享：每身份一个 IdentityRuntime + 审批代理 + 配置。启动时装配一次。"""

    def __init__(
        self,
        config: AppConfig,
        identities: dict[str, IdentityRuntime],
        approvals: ApprovalsProxy,
    ) -> None:
        self.config = config
        self.identities = identities
        self.approvals = approvals

    def identity(self, key: str) -> IdentityRuntime:
        """按 key 取身份运行态；未知 key 回退到默认身份（绝不 KeyError）。"""
        return self.identities.get(key) or self.identities[self.config.default_identity]


async def build_runtime(config: AppConfig) -> Runtime:
    # 缺 LLM 凭据不拦服务启动：静态页、身份信息、工具面、审批代理都不依赖 LLM，
    # 只有对话循环需要。缺 key 时各 agent=None，/api/chat 回一句明确提示。
    model = None
    try:
        model = build_chat_model(config.llm)
    except RuntimeError as exc:
        print(f"[langgraph] 对话未启用：{exc}")

    identities: dict[str, IdentityRuntime] = {}
    for key, gw in config.identities.items():
        tool_list = await load_gateway_tools(gw)
        tools = {t.name: t for t in tool_list}
        # 进程内 checkpointer：同一 thread_id 的多轮对话在本进程内有记忆（重启即清）。
        # 每身份各一个 agent+checkpointer，身份间记忆不串。
        agent = build_agent(model, tool_list, checkpointer=MemorySaver()) if model else None
        identities[key] = IdentityRuntime(gw, agent, tools)
        print(f"[langgraph] 身份 {key}：{gw.identity_label} → {len(tools)} 个工具")

    return Runtime(config, identities, ApprovalsProxy(config.approver))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    config = load_config()
    app.state.runtime = await build_runtime(config)
    can_approve = "可用" if config.approver.enabled else "不可用"
    print(f"[langgraph] 审批人：{config.approver.label}（就地批复{can_approve}）")
    yield


def _sse(payload: dict[str, Any]) -> dict[str, str]:
    return {"data": json.dumps(payload, ensure_ascii=False)}


async def _execute_approved(idr: IdentityRuntime, record: dict[str, Any]) -> dict[str, Any]:
    """批准后续跑：按单据的 tool+args 以发起人身份重发。网关命中已批准单 → 消费执行。
    返回 {kind, ...} 供前端如实展示；工具缺失/异常都归一成结构化结果，不抛。"""
    tool_name = record.get("tool")
    args = record.get("args") or {}
    tool = idr.tools.get(tool_name)
    if tool is None:
        return {"kind": "error", "message": f"工具 {tool_name} 不在当前身份的工具面内"}
    try:
        output = await tool.ainvoke(args)
    except Exception as exc:  # 出口纪律：细节进日志，前端收结构化 error
        print(f"[langgraph] 续跑执行出错: {exc!r}")
        return {"kind": "error", "message": "续跑执行出错"}
    result = parse_guarded_result(output)
    return result if result is not None else {"kind": "ok"}


async def _chat_events(agent: Any, message: str, thread_id: str) -> AsyncIterator[dict[str, str]]:
    config = {"configurable": {"thread_id": thread_id}}
    inputs = {"messages": [{"role": "user", "content": message}]}
    try:
        async for event in agent.astream_events(inputs, config=config, version="v2"):
            kind = event.get("event")
            if kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk")
                text = getattr(chunk, "content", "") if chunk is not None else ""
                if text:
                    yield _sse({"type": "token", "text": text})
            elif kind == "on_tool_start":
                yield _sse({"type": "tool_start", "tool": event.get("name", "")})
            elif kind == "on_tool_end":
                tool = event.get("name", "")
                output = event["data"].get("output")
                pending = as_pending(output)
                if pending is not None:
                    yield _sse(
                        {
                            "type": "pending",
                            "tool": tool,
                            "approvalId": pending.approval_id,
                            "rule": pending.rule,
                        }
                    )
                else:
                    result = parse_guarded_result(output)
                    # 网关工具一律返回 GuardedResult；解析不出说明是工具/传输错误
                    # （handle_tool_errors 把异常变成纯文本），默认 error，不能画成「已完成」
                    result_kind = result.get("kind", "error") if result else "error"
                    yield _sse({"type": "tool_end", "tool": tool, "kind": result_kind})
        yield _sse({"type": "done"})
    except Exception as exc:  # 出口纪律：细节进日志，前端只收一句通用错误
        print(f"[langgraph] 对话出错: {exc!r}")
        yield _sse({"type": "error", "message": "服务处理出错，请稍后再试"})


def create_app() -> FastAPI:
    app = FastAPI(lifespan=lifespan)

    @app.get("/api/config")
    async def api_config() -> JSONResponse:
        rt: Runtime = app.state.runtime
        identities = [
            {
                "key": key,
                "name": idr.meta.name,
                "role": idr.meta.role,
                "userId": idr.meta.user_id,
                "tokenAlg": idr.meta.token_alg,
                "domain": "CRM · Twenty",
                "tools": list(idr.tools.keys()),
            }
            for key, idr in rt.identities.items()
        ]
        return JSONResponse(
            {
                "identities": identities,
                "current": rt.config.default_identity,
                "model": rt.config.llm.model,
                "approverEnabled": rt.approvals.enabled,
            }
        )

    @app.post("/api/chat")
    async def api_chat(request: Request) -> EventSourceResponse:
        body = await request.json()
        message = str(body.get("message", "")).strip()
        thread_id = str(body.get("threadId") or "default")
        identity_key = str(body.get("identity") or app.state.runtime.config.default_identity)
        rt: Runtime = app.state.runtime
        if not message:
            return EventSourceResponse(iter([_sse({"type": "error", "message": "消息为空"})]))
        idr = rt.identity(identity_key)
        if idr.agent is None:
            return EventSourceResponse(
                iter(
                    [
                        _sse(
                            {
                                "type": "error",
                                "message": "对话未启用：服务端缺少 FOUNDRY_LLM_API_KEY",
                            }
                        )
                    ]
                )
            )
        # thread_id 按身份加前缀：切身份即换一段对话，记忆不串
        return EventSourceResponse(_chat_events(idr.agent, message, f"{identity_key}:{thread_id}"))

    @app.get("/api/pending")
    async def api_pending() -> JSONResponse:
        rt: Runtime = app.state.runtime
        if not rt.approvals.enabled:
            return JSONResponse({"approvals": [], "approverEnabled": False})
        return JSONResponse(
            {"approvals": await rt.approvals.list_pending(), "approverEnabled": True}
        )

    @app.post("/api/approvals/{approval_id}")
    async def api_decide(approval_id: str, request: Request) -> JSONResponse:
        rt: Runtime = app.state.runtime
        if not rt.approvals.enabled:
            return JSONResponse({"error": "本部署未配置审批人身份"}, status_code=501)
        body = await request.json()
        decision = str(body.get("decision", ""))
        if decision not in ("approve", "deny"):
            return JSONResponse({"error": 'decision 须为 "approve" 或 "deny"'}, status_code=400)
        status, result = await rt.approvals.decide(approval_id, decision)
        if status != 200 or decision == "deny":
            return JSONResponse(result, status_code=status)
        # 批准成功 → 立即以发起人身份重发这次调用，网关命中已批准单消费执行。
        # 直接按单据里的 tool+args 重发（而非让 LLM 重发）——确定消票，不受对话记忆干扰。
        # 发起人即默认身份（只读经理不能发起写，故审批续跑一律走默认销售身份的工具表）。
        execution = await _execute_approved(rt.identity(rt.config.default_identity), result)
        return JSONResponse({"approval": result, "execution": execution}, status_code=200)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    if (WEB_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    return app


app = create_app()
