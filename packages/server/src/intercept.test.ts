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

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
`);

const callBody = (name: string) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('越权 tools/call 拦截', () => {
  it('白名单外但真实存在的工具：返回结构化拒答响应，且审计记 DENY', async () => {
    const audit = new MemoryAuditLogger();
    const guard = new Guard(rbac, audit);

    const denied = await interceptDeniedToolCall(
      [fakeHr],
      guard,
      { userId: 'e002', role: 'employee' },
      callBody('get_salary'),
    );

    expect(denied).not.toBeNull();
    const text = (denied as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({ kind: 'refusal', reason: 'tool_not_allowed' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.decision).toBe('DENY');
  });

  it('白名单内的工具：放行（返回 null 交给 SDK 正常处理）', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const denied = await interceptDeniedToolCall(
      [fakeHr],
      guard,
      { userId: 'e002', role: 'employee' },
      callBody('list_employees'),
    );

    expect(denied).toBeNull();
  });

  it('真不存在的工具：返回 null，由 SDK 报 not found', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const denied = await interceptDeniedToolCall(
      [fakeHr],
      guard,
      { userId: 'e002', role: 'employee' },
      callBody('drop_database'),
    );

    expect(denied).toBeNull();
  });

  it('非 tools/call 消息（tools/list、initialize）不拦截', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    for (const method of ['tools/list', 'initialize']) {
      const denied = await interceptDeniedToolCall(
        [fakeHr],
        guard,
        { userId: 'e002', role: 'employee' },
        { jsonrpc: '2.0', id: 1, method },
      );
      expect(denied).toBeNull();
    }
  });
});
