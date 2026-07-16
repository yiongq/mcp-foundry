import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import type { EspoCrmBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
import type { MySqlBackendOptions } from './mysql.js';
import { MySqlEspoCrmBackend } from './mysql.js';
import {
  accountIdInput,
  contactIdInput,
  listAccountsInput,
  listOpportunitiesInput,
  opportunityIdInput,
  pipelineSummaryInput,
  TOOL_SPECS,
} from './tools.js';

export interface EspoCrmAdapterOptions {
  /**
   * 后端选择优先级：backend 注入 > mode 显式指定 > 环境变量探测 > fixture。
   * 环境变量：ESPOCRM_MYSQL_HOST + ESPOCRM_MYSQL_USER + ESPOCRM_MYSQL_PASSWORD
   * （库名缺省 espocrm、端口缺省 3306）。真库对接见 docs/espocrm-db-schema.md。
   */
  mode?: 'fixture' | 'mysql';
  /** 直接注入后端实例（评测多题共享一个连接池就靠它） */
  backend?: EspoCrmBackend;
  mysql?: MySqlBackendOptions;
  /** 测试注入用；缺省 process.env */
  env?: Record<string, string | undefined>;
}

export function createEspoCrmAdapter(options: EspoCrmAdapterOptions = {}): SystemAdapter {
  return new EspoCrmAdapter(selectBackend(options));
}

function selectBackend(options: EspoCrmAdapterOptions): EspoCrmBackend {
  if (options.backend !== undefined) return options.backend;
  const env = options.env ?? process.env;
  const mysqlConfig = options.mysql ?? mysqlConfigFromEnv(env);
  const mode = options.mode ?? (mysqlConfig ? 'mysql' : 'fixture');
  if (mode === 'mysql') {
    if (!mysqlConfig) {
      throw new Error(
        'espocrm MySQL 模式需要 ESPOCRM_MYSQL_HOST + ESPOCRM_MYSQL_USER + ESPOCRM_MYSQL_PASSWORD',
      );
    }
    return new MySqlEspoCrmBackend(mysqlConfig);
  }
  return new FixtureBackend();
}

export function mysqlConfigFromEnv(
  env: Record<string, string | undefined>,
): MySqlBackendOptions | null {
  const host = env.ESPOCRM_MYSQL_HOST;
  const user = env.ESPOCRM_MYSQL_USER;
  const password = env.ESPOCRM_MYSQL_PASSWORD;
  if (!host || !user || password === undefined) return null;
  return {
    host,
    port: Number(env.ESPOCRM_MYSQL_PORT ?? '3306'),
    database: env.ESPOCRM_MYSQL_DATABASE ?? 'espocrm',
    user,
    password,
  };
}

class EspoCrmAdapter implements SystemAdapter {
  readonly system = 'espocrm';

  constructor(private readonly backend: EspoCrmBackend) {}

  tools(): ToolSpec[] {
    return [...TOOL_SPECS];
  }

  async execute(call: ToolCall, _principal: Principal): Promise<AdapterResult> {
    switch (call.tool) {
      case 'list_accounts': {
        const { industry } = listAccountsInput.parse(call.args);
        return { data: await this.backend.listAccounts(industry) };
      }
      case 'get_account': {
        const { account_id } = accountIdInput.parse(call.args);
        return { data: await this.backend.getAccount(account_id) };
      }
      case 'get_contact': {
        const { contact_id } = contactIdInput.parse(call.args);
        return { data: await this.backend.getContact(contact_id) };
      }
      case 'list_opportunities': {
        const { stage } = listOpportunitiesInput.parse(call.args);
        return { data: await this.backend.listOpportunities(stage) };
      }
      case 'get_opportunity': {
        const { opportunity_id } = opportunityIdInput.parse(call.args);
        return { data: await this.backend.getOpportunity(opportunity_id) };
      }
      case 'get_pipeline_summary': {
        pipelineSummaryInput.parse(call.args);
        return { data: await this.backend.getPipelineSummary() };
      }
      default:
        throw new Error(`espocrm: 未知工具 "${call.tool}"`);
    }
  }
}
