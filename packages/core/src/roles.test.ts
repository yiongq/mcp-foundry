import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryAuditLogger } from './audit.js';
import { Guard } from './guard.js';
import { loadRbacConfig, roleForSystem, withSystemRole } from './rbac.js';
import type { Principal, SystemAdapter } from './types.js';

// 多帽子：同一人在 HR 是 hr_admin、在 CRM 是 sales_manager
const multiHat: Principal = {
  userId: 'e004',
  role: 'hr_admin',
  rolesBySystem: { twenty: 'sales_manager' },
};

describe('roleForSystem / withSystemRole（按系统解析角色）', () => {
  it('rolesBySystem 命中 → 用系统专属角色', () => {
    expect(roleForSystem(multiHat, 'twenty')).toBe('sales_manager');
  });

  it('rolesBySystem 未命中 → 回落到缺省 role', () => {
    expect(roleForSystem(multiHat, 'orangehrm')).toBe('hr_admin');
  });

  it('单角色（无 rolesBySystem）→ 全系统同一角色（旧行为不变）', () => {
    const single: Principal = { userId: 'e007', role: 'sales_rep' };
    expect(roleForSystem(single, 'twenty')).toBe('sales_rep');
    expect(roleForSystem(single, 'orangehrm')).toBe('sales_rep');
  });

  it('withSystemRole：命中返回改了 role 的副本，未命中原样返回（同引用）', () => {
    const forCrm = withSystemRole(multiHat, 'twenty');
    expect(forCrm.role).toBe('sales_manager');
    expect(forCrm.userId).toBe('e004');
    expect(withSystemRole(multiHat, 'orangehrm')).toBe(multiHat);
  });
});

function adapterFor(system: string, tool: string): SystemAdapter {
  return {
    system,
    tools: () => [{ name: tool, description: tool, inputSchema: z.object({}) }],
    execute: async () => ({ data: { system, tool } }),
  };
}

const hrRbac = loadRbacConfig('roles:\n  hr_admin:\n    tools: [read_hr]\n');
const crmRbac = loadRbacConfig('roles:\n  sales_manager:\n    tools: [read_crm]\n');

describe('多帽子 principal 在守卫里按系统落权限', () => {
  it('HR 系统用 hr_admin → 放行 read_hr', async () => {
    const guard = new Guard(hrRbac, new MemoryAuditLogger());
    const res = await guard.invoke(adapterFor('orangehrm', 'read_hr'), multiHat, {
      tool: 'read_hr',
      args: {},
    });
    expect(res.kind).toBe('ok');
  });

  it('CRM 系统用 sales_manager → 放行 read_crm', async () => {
    const guard = new Guard(crmRbac, new MemoryAuditLogger());
    const res = await guard.invoke(adapterFor('twenty', 'read_crm'), multiHat, {
      tool: 'read_crm',
      args: {},
    });
    expect(res.kind).toBe('ok');
  });

  it('无多帽子的 hr_admin 进 CRM → unknown_role（域隔离仍在）', async () => {
    const single: Principal = { userId: 'e004', role: 'hr_admin' };
    const guard = new Guard(crmRbac, new MemoryAuditLogger());
    const res = await guard.invoke(adapterFor('twenty', 'read_crm'), single, {
      tool: 'read_crm',
      args: {},
    });
    expect(res.kind).toBe('refusal');
    if (res.kind === 'refusal') expect(res.reason).toBe('unknown_role');
  });

  it('allowedTools 也按系统解析：多帽子在 CRM 见到 sales_manager 的工具面', () => {
    const guard = new Guard(crmRbac, new MemoryAuditLogger());
    const tools = guard.allowedTools(adapterFor('twenty', 'read_crm'), multiHat);
    expect(tools.map((t) => t.name)).toEqual(['read_crm']);
  });

  it('审计记录的是解析后的系统角色（sales_manager，不是缺省 hr_admin）', async () => {
    const audit = new MemoryAuditLogger();
    const guard = new Guard(crmRbac, audit);
    await guard.invoke(adapterFor('twenty', 'read_crm'), multiHat, { tool: 'read_crm', args: {} });
    expect(audit.events.at(-1)?.role).toBe('sales_manager');
  });
});
