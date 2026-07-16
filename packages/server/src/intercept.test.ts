import { Guard, loadRbacConfig, MemoryAuditLogger, type SystemAdapter } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { interceptDeniedToolCall } from './server.js';

const fakeHr: SystemAdapter = {
  system: 'fake-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    { name: 'get_salary', description: '查薪资', inputSchema: z.object({ id: z.string() }) },
  ],
  execute: async () => ({ data: [] }),
};

const fakeCrm: SystemAdapter = {
  system: 'fake-crm',
  tools: () => [{ name: 'get_pipeline_summary', description: '业绩盘', inputSchema: z.object({}) }],
  execute: async () => ({ data: [] }),
};

const hrRbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
  hr_admin:
    tools: "*"
`);

const crmRbac = loadRbacConfig(`
roles:
  sales_manager:
    tools: "*"
`);

const buildSystems = (audit: MemoryAuditLogger) => [
  { adapter: fakeHr, guard: new Guard(hrRbac, audit) },
  { adapter: fakeCrm, guard: new Guard(crmRbac, audit) },
];

const callBody = (name: string) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('越权 tools/call 拦截', () => {
  it('白名单外但真实存在的工具：返回结构化拒答响应，且审计记 DENY', async () => {
    const audit = new MemoryAuditLogger();

    const denied = await interceptDeniedToolCall(
      buildSystems(audit),
      { userId: 'e002', role: 'employee' },
      callBody('get_salary'),
    );

    expect(denied).not.toBeNull();
    const text = (denied as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({ kind: 'refusal', reason: 'tool_not_allowed' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.decision).toBe('DENY');
  });

  it('跨域越权：HR 通配角色摸 CRM 工具 → 按 CRM 域裁决 unknown_role，审计记在 CRM 域名下', async () => {
    const audit = new MemoryAuditLogger();

    const denied = await interceptDeniedToolCall(
      buildSystems(audit),
      { userId: 'e004', role: 'hr_admin' },
      callBody('get_pipeline_summary'),
    );

    expect(denied).not.toBeNull();
    const text = (denied as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({ kind: 'refusal', reason: 'unknown_role' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.decision).toBe('DENY');
    expect(audit.events[0]?.system).toBe('fake-crm');
  });

  it('白名单内的工具：放行（返回 null 交给 SDK 正常处理）', async () => {
    const denied = await interceptDeniedToolCall(
      buildSystems(new MemoryAuditLogger()),
      { userId: 'e002', role: 'employee' },
      callBody('list_employees'),
    );

    expect(denied).toBeNull();
  });

  it('真不存在的工具：返回 null，由 SDK 报 not found', async () => {
    const denied = await interceptDeniedToolCall(
      buildSystems(new MemoryAuditLogger()),
      { userId: 'e002', role: 'employee' },
      callBody('drop_database'),
    );

    expect(denied).toBeNull();
  });

  it('非 tools/call 消息（tools/list、initialize）不拦截', async () => {
    for (const method of ['tools/list', 'initialize']) {
      const denied = await interceptDeniedToolCall(
        buildSystems(new MemoryAuditLogger()),
        { userId: 'e002', role: 'employee' },
        { jsonrpc: '2.0', id: 1, method },
      );
      expect(denied).toBeNull();
    }
  });
});
