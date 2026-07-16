import type { AdapterResult, SystemAdapter, ToolCall, ToolSpec } from '@yiong/foundry-core';
import type { OrangeHrmBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
import type { OrangeHrmRestOptions } from './rest.js';
import { OrangeHrmRestBackend } from './rest.js';
import { employeeIdInput, listEmployeesInput, TOOL_SPECS } from './tools.js';

export interface OrangeHrmAdapterOptions {
  /**
   * 缺省自动判断：有 REST 配置（options.rest 或 ORANGEHRM_BASE_URL +
   * ORANGEHRM_CLIENT_ID + ORANGEHRM_CLIENT_SECRET 环境变量）走 rest，否则 fixture。
   */
  mode?: 'fixture' | 'rest';
  rest?: OrangeHrmRestOptions;
  /** 测试注入用；缺省 process.env */
  env?: Record<string, string | undefined>;
}

export function createOrangeHrmAdapter(options: OrangeHrmAdapterOptions = {}): SystemAdapter {
  return new OrangeHrmAdapter(selectBackend(options));
}

function selectBackend(options: OrangeHrmAdapterOptions): OrangeHrmBackend {
  const env = options.env ?? process.env;
  const restConfig = options.rest ?? restConfigFromEnv(env);
  const mode = options.mode ?? (restConfig ? 'rest' : 'fixture');
  if (mode === 'rest') {
    if (!restConfig) {
      throw new Error(
        'orangehrm REST 模式需要 ORANGEHRM_BASE_URL + ORANGEHRM_CLIENT_ID + ORANGEHRM_CLIENT_SECRET',
      );
    }
    return new OrangeHrmRestBackend(restConfig);
  }
  return new FixtureBackend();
}

function restConfigFromEnv(env: Record<string, string | undefined>): OrangeHrmRestOptions | null {
  const baseUrl = env.ORANGEHRM_BASE_URL;
  const clientId = env.ORANGEHRM_CLIENT_ID;
  const clientSecret = env.ORANGEHRM_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) return null;
  return { baseUrl, clientId, clientSecret };
}

class OrangeHrmAdapter implements SystemAdapter {
  readonly system = 'orangehrm';

  constructor(private readonly backend: OrangeHrmBackend) {}

  tools(): ToolSpec[] {
    return [...TOOL_SPECS];
  }

  async execute(call: ToolCall): Promise<AdapterResult> {
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
