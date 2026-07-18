"""FastAPI 入口：SSE 流式对话 + 审批代理 + 自建前端托管。

对话走 LangGraph react agent 的 astream_events，映射成前端好消费的事件流：
token 增量、工具开始/结束、pending 审批态、完成。审批闸门的 pending 不当普通
工具输出，单独发一条 pending 事件，让前端就地弹审批卡片。
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
from .config import AppConfig, load_config
from .gateway import as_pending, load_gateway_tools, parse_guarded_result

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class Runtime:
    """进程级共享：编译好的 agent、审批代理、工具表、配置。启动时装配一次。
    agent 可能为 None（缺 LLM 凭据）——此时页面/审批仍可用，只有对话返回明确提示。
    tools 按名保留：批准后由客户端以发起人身份直接重发那一次调用，确定地消票执行——
    不走 LLM 重发（线程有记忆时 LLM 会以为已提交、不再调工具，票永远消费不掉）。"""

    def __init__(
        self,
        config: AppConfig,
        agent: Any,
        approvals: ApprovalsProxy,
        tools: dict[str, Any],
    ) -> None:
        self.config = config
        self.agent = agent
        self.approvals = approvals
        self.tools = tools


async def build_runtime(config: AppConfig) -> Runtime:
    tool_list = await load_gateway_tools(config.gateway)
    tools = {t.name: t for t in tool_list}
    # 缺 LLM 凭据不拦服务启动：静态页、身份信息、审批代理都不依赖 LLM，
    # 只有对话循环需要。缺 key 时 agent=None，/api/chat 回一句明确提示。
    try:
        model = build_chat_model(config.llm)
        # 进程内 checkpointer：同一 thread_id 的多轮对话在本进程内有记忆（重启即清）
        agent = build_agent(model, tool_list, checkpointer=MemorySaver())
    except RuntimeError as exc:
        print(f"[langgraph] 对话未启用：{exc}")
        agent = None
    return Runtime(config, agent, ApprovalsProxy(config.approver), tools)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    config = load_config()
    app.state.runtime = await build_runtime(config)
    print(f"[langgraph] 网关身份：{config.gateway.identity_label} → {config.gateway.url}")
    can_approve = "可用" if config.approver.enabled else "不可用"
    print(f"[langgraph] 审批人：{config.approver.label}（就地批复{can_approve}）")
    yield


def _sse(payload: dict[str, Any]) -> dict[str, str]:
    return {"data": json.dumps(payload, ensure_ascii=False)}


async def _execute_approved(runtime: Runtime, record: dict[str, Any]) -> dict[str, Any]:
    """批准后续跑：按单据的 tool+args 以发起人身份重发。网关命中已批准单 → 消费执行。
    返回 {kind, ...} 供前端如实展示；工具缺失/异常都归一成结构化结果，不抛。"""
    tool_name = record.get("tool")
    args = record.get("args") or {}
    tool = runtime.tools.get(tool_name)
    if tool is None:
        return {"kind": "error", "message": f"工具 {tool_name} 不在当前身份的工具面内"}
    try:
        output = await tool.ainvoke(args)
    except Exception as exc:  # 出口纪律：细节进日志，前端收结构化 error
        print(f"[langgraph] 续跑执行出错: {exc!r}")
        return {"kind": "error", "message": "续跑执行出错"}
    result = parse_guarded_result(output)
    return result if result is not None else {"kind": "ok"}


async def _chat_events(
    runtime: Runtime, message: str, thread_id: str
) -> AsyncIterator[dict[str, str]]:
    config = {"configurable": {"thread_id": thread_id}}
    inputs = {"messages": [{"role": "user", "content": message}]}
    try:
        async for event in runtime.agent.astream_events(inputs, config=config, version="v2"):
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
        return JSONResponse(
            {
                "identity": rt.config.gateway.identity_label,
                "model": rt.config.llm.model,
                "approverEnabled": rt.approvals.enabled,
            }
        )

    @app.post("/api/chat")
    async def api_chat(request: Request) -> EventSourceResponse:
        body = await request.json()
        message = str(body.get("message", "")).strip()
        thread_id = str(body.get("threadId") or "default")
        rt: Runtime = app.state.runtime
        if not message:
            return EventSourceResponse(iter([_sse({"type": "error", "message": "消息为空"})]))
        if rt.agent is None:
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
        return EventSourceResponse(_chat_events(rt, message, thread_id))

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
        execution = await _execute_approved(rt, result)
        return JSONResponse({"approval": result, "execution": execution}, status_code=200)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    if (WEB_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    return app


app = create_app()
