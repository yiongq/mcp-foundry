import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import type { OrangeHrmBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
import type { MySqlBackendOptions } from './mysql.js';
import { MySqlOrangeHrmBackend } from './mysql.js';
import type { OrangeHrmRestOptions } from './rest.js';
import { OrangeHrmRestBackend } from './rest.js';
import { employeeIdInput, listEmployeesInput, TOOL_SPECS } from './tools.js';

export interface OrangeHrmAdapterOptions {
  /**
   * 后端选择优先级：backend 注入 > mode 显式指定 > 环境变量探测 > fixture。
   * 环境变量：MySQL 看 ORANGEHRM_MYSQL_HOST + ORANGEHRM_MYSQL_USER + ORANGEHRM_MYSQL_PASSWORD
   * （库名缺省 orangehrm、端口缺省 3306）；REST 看 ORANGEHRM_BASE_URL +
   * ORANGEHRM_CLIENT_ID + ORANGEHRM_CLIENT_SECRET。两者都在时 MySQL 优先——
   * OS 版 REST 不支持 client_credentials（docs/orangehrm-api-notes.md）。
   */
  mode?: 'fixture' | 'rest' | 'mysql';
  /** 直接注入后端实例（评测多题共享一个连接池就靠它） */
  backend?: OrangeHrmBackend;
  rest?: OrangeHrmRestOptions;
  mysql?: MySqlBackendOptions;
  /** 测试注入用；缺省 process.env */
  env?: Record<string, string | undefined>;
}

export function createOrangeHrmAdapter(options: OrangeHrmAdapterOptions = {}): SystemAdapter {
  return new OrangeHrmAdapter(selectBackend(options));
}

function selectBackend(options: OrangeHrmAdapterOptions): OrangeHrmBackend {
  if (options.backend !== undefined) return options.backend;
  const env = options.env ?? process.env;
  const mysqlConfig = options.mysql ?? mysqlConfigFromEnv(env);
  const restConfig = options.rest ?? restConfigFromEnv(env);
  const mode = options.mode ?? (mysqlConfig ? 'mysql' : restConfig ? 'rest' : 'fixture');
  if (mode === 'mysql') {
    if (!mysqlConfig) {
      throw new Error(
        'orangehrm MySQL 模式需要 ORANGEHRM_MYSQL_HOST + ORANGEHRM_MYSQL_USER + ORANGEHRM_MYSQL_PASSWORD',
      );
    }
    return new MySqlOrangeHrmBackend(mysqlConfig);
  }
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

export function mysqlConfigFromEnv(
  env: Record<string, string | undefined>,
): MySqlBackendOptions | null {
  const host = env.ORANGEHRM_MYSQL_HOST;
  const user = env.ORANGEHRM_MYSQL_USER;
  const password = env.ORANGEHRM_MYSQL_PASSWORD;
  if (!host || !user || password === undefined) return null;
  return {
    host,
    port: Number(env.ORANGEHRM_MYSQL_PORT ?? '3306'),
    database: env.ORANGEHRM_MYSQL_DATABASE ?? 'orangehrm',
    user,
    password,
    ...(env.ORANGEHRM_LEAVE_TYPE !== undefined ? { leaveTypeName: env.ORANGEHRM_LEAVE_TYPE } : {}),
  };
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
