import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import type { OrangeHrmBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
import { employeeIdInput, listEmployeesInput, TOOL_SPECS } from './tools.js';

/**
 * OrangeHRM（HR 域）适配器——生产与评测都走 fixture 演示数据（6 人）。
 * 早期支持连真实 OrangeHRM 5.7 的后端（只读 MySQL / REST）在 docker 下线后移除：
 * 生产 HR 一律 fixture（见 DEPLOY-CHECKLIST），本地也不再需要一套真库栈。权限统一收口
 * 在守卫层、与后端无关——这正是「适配器只管接得通、越权数据在守卫出口不存在」的边界。
 */
export function createOrangeHrmAdapter(): SystemAdapter {
  return new OrangeHrmAdapter(new FixtureBackend());
}

class OrangeHrmAdapter implements SystemAdapter {
  readonly system = 'orangehrm';

  constructor(private readonly backend: OrangeHrmBackend) {}

  tools(): ToolSpec[] {
    return [...TOOL_SPECS];
  }

  async execute(call: ToolCall, _principal: Principal): Promise<AdapterResult> {
    switch (call.tool) {
      case 'list_employees': {
        const { dept } = listEmployeesInput.parse(call.args);
        return { data: await this.backend.listEmployees(dept) };
      }
      case 'get_employee': {
        const { employee_id } = employeeIdInput.parse(call.args);
        return { data: await this.backend.getEmployee(employee_id) };
      }
      case 'get_leave_balance': {
        const { employee_id } = employeeIdInput.parse(call.args);
        return { data: await this.backend.getLeaveBalance(employee_id) };
      }
      case 'get_salary': {
        const { employee_id } = employeeIdInput.parse(call.args);
        return { data: await this.backend.getSalary(employee_id) };
      }
      default:
        throw new Error(`orangehrm: 未知工具 "${call.tool}"`);
    }
  }
}
