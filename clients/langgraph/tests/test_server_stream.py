"""SSE 事件映射：把 LangGraph astream_events 的原始事件翻成前端事件流。
重点覆盖 pending 走单独事件（不当普通 tool_end），token 增量、工具起止的 kind 归类。"""

import json

import pytest

from app.server import IdentityRuntime, _chat_events


class _Chunk:
    def __init__(self, content: str):
        self.content = content


class _ToolMsg:
    def __init__(self, content):
        self.content = content


def _block(text: str):
    return [{"type": "text", "text": text}]


class FakeAgent:
    """astream_events 的最小替身：按脚本吐 LangGraph 风格事件。"""

    def __init__(self, events):
        self._events = events

    async def astream_events(self, inputs, config, version):  # noqa: ARG002
        for e in self._events:
            yield e


async def _collect(events):
    out = []
    async for frame in _chat_events(FakeAgent(events), "hi", "t1"):
        out.append(json.loads(frame["data"]))
    return out


@pytest.mark.asyncio
async def test_tokens_tools_and_done_sequence():
    events = [
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("你好")}},
        {"event": "on_tool_start", "name": "list_contacts", "data": {}},
        {
            "event": "on_tool_end",
            "name": "list_contacts",
            "data": {"output": _ToolMsg(_block('{"kind":"ok","data":[],"maskedFields":[]}'))},
        },
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk("，共 0 条")}},
    ]
    out = await _collect(events)
    types = [o["type"] for o in out]
    assert types == ["token", "tool_start", "tool_end", "token", "done"]
    assert out[0]["text"] == "你好"
    assert out[2] == {"type": "tool_end", "tool": "list_contacts", "kind": "ok"}


@pytest.mark.asyncio
async def test_pending_gets_dedicated_event_not_tool_end():
    pending_json = '{"kind":"pending","reason":"approval_required","approvalId":"abc12345-x","rule":"approval:sales_rep"}'
    events = [
        {"event": "on_tool_start", "name": "delete_contact", "data": {}},
        {
            "event": "on_tool_end",
            "name": "delete_contact",
            "data": {"output": _ToolMsg(_block(pending_json))},
        },
    ]
    out = await _collect(events)
    kinds = [o["type"] for o in out]
    assert "pending" in kinds
    assert "tool_end" not in kinds  # pending 不降级成普通 tool_end
    pending = next(o for o in out if o["type"] == "pending")
    assert pending["approvalId"] == "abc12345-x"
    assert pending["tool"] == "delete_contact"


@pytest.mark.asyncio
async def test_refusal_maps_to_tool_end_kind_refusal():
    events = [
        {"event": "on_tool_start", "name": "delete_contact", "data": {}},
        {
            "event": "on_tool_end",
            "name": "delete_contact",
            "data": {
                "output": _ToolMsg(_block('{"kind":"refusal","reason":"row_denied","rule":"r"}'))
            },
        },
    ]
    out = await _collect(events)
    tool_end = next(o for o in out if o["type"] == "tool_end")
    assert tool_end["kind"] == "refusal"


@pytest.mark.asyncio
async def test_unparseable_tool_output_maps_to_error_not_ok():
    # 工具输出不是 GuardedResult（如 handle_tool_errors 变成的纯文本报错）→ error，
    # 不能默认 ok 把失败画成「已完成」
    events = [
        {"event": "on_tool_start", "name": "list_contacts", "data": {}},
        {"event": "on_tool_end", "name": "list_contacts", "data": {"output": "Error: boom"}},
    ]
    out = await _collect(events)
    tool_end = next(o for o in out if o["type"] == "tool_end")
    assert tool_end["kind"] == "error"


class _FakeTool:
    def __init__(self, output):
        self._output = output

    async def ainvoke(self, args):
        self._seen = args
        return self._output


@pytest.mark.asyncio
async def test_execute_approved_reissues_stored_call():
    from app.server import _execute_approved

    tool = _FakeTool(_block('{"kind":"ok","data":{"contact_id":"c005"},"maskedFields":["phone"]}'))
    idr = IdentityRuntime(meta=None, agent=None, tools={"update_contact": tool})
    record = {"tool": "update_contact", "args": {"contact_id": "c005", "title": "x"}}

    result = await _execute_approved(idr, record)
    assert result["kind"] == "ok"
    # 用单据里存的原 args 重发（不经 LLM）——保证 argsHash 一致、命中已批准单
    assert tool._seen == {"contact_id": "c005", "title": "x"}


@pytest.mark.asyncio
async def test_execute_approved_missing_tool_returns_error():
    from app.server import _execute_approved

    idr = IdentityRuntime(meta=None, agent=None, tools={})
    result = await _execute_approved(idr, {"tool": "gone", "args": {}})
    assert result["kind"] == "error"
