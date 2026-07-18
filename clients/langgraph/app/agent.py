"""LangGraph agent 组装 + 系统提示词。

提示词对 GuardedResult 各分支的处理口径与飞书入口（packages/feishu/src/agent.ts）
保持一致——同一个网关、同一套结构化出口，换个 agent 框架不该换一套话术。
关键：安全不靠提示词。工具面已按身份收窄、越权数据在网关出口就不存在、写操作被
闸门挡在执行前——提示词只负责把这些结构化结果转成人话，不承担任何权限职责。
"""

from __future__ import annotations

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.prebuilt import create_react_agent

from .config import LlmConfig

SYSTEM_PROMPT = """你是企业内部数据助手，通过带权限守卫的 MCP 网关查询/维护企业系统（HR / CRM 等），用中文简洁回答。

工具面已按你的身份收窄，列表外的能力不存在，不要虚构。每个工具返回的是网关守卫出口的 JSON：
- kind=ok：用 data 里的数据回答，不要编造 data 里没有的数值。结果是按你的权限过滤后的“可见范围”——
  列表短/查不到只说明你无权看到，不代表数据不存在；表述用“在你的可见范围内没有找到”，
  绝不断言“系统中只有/不存在”。
- kind=refusal：权限系统的最终裁决（unknown_role=身份未认得 / tool_not_allowed=无权用此工具 /
  row_denied=无权动此数据 / approval_denied=此前提交的审批被拒）。如实告知被拒与原因，
  说明“本次访问已记入审计日志”，不要尝试绕过、不要替用户猜数据。
- kind=pending：该操作是高危写入，网关已自动提交人工审批（approvalId 是单号）。告诉用户
  “已提交审批（单号取 approvalId 前 8 位），管理员批准后会自动执行并通知你”。本轮不要重试该工具、
  不要换参数重发；用户追问进度时如实说明在等待批复。
- kind=error：参数或系统错误，向用户说明并建议修正问法。

回答保持紧凑：直接给结论，不客套；列表/表格只在真有多条数据时用。"""


def build_chat_model(llm: LlmConfig) -> BaseChatModel:
    if not llm.api_key:
        raise RuntimeError("缺少 FOUNDRY_LLM_API_KEY——构建对话 agent 需要 LLM 凭据")
    return ChatOpenAI(
        base_url=llm.base_url,
        api_key=llm.api_key,
        model=llm.model,
        temperature=0,
        # 思考链让一次问答慢到 30s+，对话延迟优先关掉（与飞书入口同款取舍）
        extra_body={"thinking": {"type": "disabled"}},
    )


def build_agent(
    model: BaseChatModel,
    tools: list[BaseTool],
    checkpointer: BaseCheckpointSaver | None = None,
):
    """create_react_agent 内部就是「模型 → 工具 → 回模型」的循环，
    与飞书入口的 runToolLoop 同构；网关的 GuardedResult 原样作为 ToolMessage 回喂模型。
    传 checkpointer 则同一 thread_id 的多轮对话在进程内有记忆。"""
    return create_react_agent(model, tools, prompt=SYSTEM_PROMPT, checkpointer=checkpointer)
