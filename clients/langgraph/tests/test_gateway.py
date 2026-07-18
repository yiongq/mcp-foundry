"""网关结果解析：重点是 langchain-mcp-adapters 的工具返回内容块列表而非裸字符串，
GuardedResult 各分支要从块里正确抠出来。真机验证时踩过这个坑（as_pending 拿到 list 返回 None）。"""

from app.gateway import PendingApproval, as_pending, parse_guarded_result, result_text


def block(text: str):
    """模拟 langchain-mcp-adapters 工具输出的内容块列表形状。"""
    return [{"type": "text", "text": text, "id": "lc_x"}]


PENDING_JSON = '{"kind":"pending","reason":"approval_required","approvalId":"d216dd87-abcd","rule":"approval:sales_rep"}'
OK_JSON = '{"kind":"ok","data":{"contact_id":"c001"},"maskedFields":["phone"]}'
REFUSAL_JSON = '{"kind":"refusal","reason":"row_denied","rule":"owner_id==$self"}'


class _MsgLike:
    def __init__(self, content):
        self.content = content


def test_result_text_handles_str_list_and_message():
    assert result_text(OK_JSON) == OK_JSON
    assert result_text(block(OK_JSON)) == OK_JSON
    assert result_text(_MsgLike(block(OK_JSON))) == OK_JSON
    assert result_text(_MsgLike(OK_JSON)) == OK_JSON


def test_parse_guarded_result_from_content_blocks():
    # 内容块列表（真实 MCP 工具输出形状）必须解析成功——这正是真机踩到的坑
    assert parse_guarded_result(block(OK_JSON))["kind"] == "ok"
    assert parse_guarded_result(block(REFUSAL_JSON))["reason"] == "row_denied"


def test_parse_guarded_result_rejects_non_guarded():
    assert parse_guarded_result(block('{"foo":1}')) is None  # 无 kind 字段
    assert parse_guarded_result(block("not json")) is None
    assert parse_guarded_result(None) is None
    assert parse_guarded_result(block("42")) is None  # 合法 JSON 但非 dict


def test_as_pending_extracts_approval_id():
    p = as_pending(block(PENDING_JSON))
    assert isinstance(p, PendingApproval)
    assert p.approval_id == "d216dd87-abcd"
    assert p.rule == "approval:sales_rep"


def test_as_pending_none_for_non_pending():
    assert as_pending(block(OK_JSON)) is None
    assert as_pending(block(REFUSAL_JSON)) is None
    # kind=pending 但缺 approvalId → 不认（防半截数据当成有效审批态）
    assert as_pending(block('{"kind":"pending","rule":"x"}')) is None
