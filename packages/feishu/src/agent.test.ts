import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { answer, buildSystemPrompt } from './agent.js';
import type { runToolLoop } from './llm.js';
import { GuardedToolset } from './toolset.js';

const rbacHr = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees, get_employee, get_leave_balance]
    rows:
      - field: employee_id
        equals: $self.userId
    mask: [salary, phone]
  hr_admin:
    tools: "*"
`);

const rbacMemory = loadRbacConfig(`
roles:
  employee:
    tools: [save_memory, recall_memories, get_memory]
    rows:
      - field: employee_id
        equals: $self.userId
`);

function buildToolset(): GuardedToolset {
  const audit = new MemoryAuditLogger();
  return new GuardedToolset([
    { adapter: createOrangeHrmAdapter({ env: {} }), guard: new Guard(rbacHr, audit) },
    { adapter: createMemoryAdapter(new MemoryStore()), guard: new Guard(rbacMemory, audit) },
  ]);
}

const XIAO_WANG: Principal = { userId: 'e002', role: 'employee' };
const LLM = { baseUrl: 'https://x', apiKey: 'k', model: 'm' };

describe('agent', () => {
  it('系统提示词带身份与收窄后的工具名单', () => {
    const toolset = buildToolset();
    const prompt = buildSystemPrompt(XIAO_WANG, toolset.allowedTools(XIAO_WANG));

    expect(prompt).toContain('userId=e002');
    expect(prompt).toContain('role=employee');
    expect(prompt).toContain('get_leave_balance');
    expect(prompt).not.toContain('get_salary');
    expect(prompt).toContain('row_denied');
  });

  it('answer 把收窄后的工具与守卫执行器接给 LLM 循环；工具结果是守卫出口 JSON', async () => {
    const toolset = buildToolset();
    const captured: {
      tools?: string[];
      toolResult?: string;
    } = {};

    const fakeLoop: typeof runToolLoop = async (_opts, _sys, _user, tools, execute) => {
      captured.tools = tools.map((t) => t.name);
      // 模拟模型发起一次越权调用：员工查别人的假期
      captured.toolResult = await execute('get_leave_balance', { employee_id: 'e001' });
      return '张三的假期你无权查看（已记入审计）。';
    };

    const reply = await answer(
      { toolset, llm: LLM, runLoop: fakeLoop },
      XIAO_WANG,
      '帮我查张三的假期',
    );

    expect(reply).toContain('无权');
    expect(captured.tools).not.toContain('get_salary');
    const result = JSON.parse(captured.toolResult ?? '{}') as { kind: string; reason?: string };
    expect(result.kind).toBe('refusal');
    expect(result.reason).toBe('row_denied');
    // 拒答分支没有 data —— 模型想编也没材料
    expect(captured.toolResult).not.toContain('"data"');
  });
});
