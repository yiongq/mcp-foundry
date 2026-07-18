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
import type { EspoCrmRestOptions } from './rest.js';
import { EspoCrmRestWriter } from './rest.js';
import {
  accountIdInput,
  contactIdInput,
  createContactInput,
  listAccountsInput,
  listContactsInput,
  listOpportunitiesInput,
  opportunityIdInput,
  pipelineSummaryInput,
  TOOL_SPECS,
  updateContactInput,
  updateOpportunityStageInput,
} from './tools.js';

export interface EspoCrmAdapterOptions {
  /**
   * 后端选择优先级：backend 注入 > mode 显式指定 > 环境变量探测 > fixture。
   * 环境变量：ESPOCRM_MYSQL_HOST + ESPOCRM_MYSQL_USER + ESPOCRM_MYSQL_PASSWORD
   * （库名缺省 espocrm、端口缺省 3306）。真库对接见 docs/espocrm-db-schema.md。
   * 写通道独立叠加：ESPOCRM_REST_URL + ESPOCRM_REST_API_KEY 存在时，写工具走 REST，
   * 读路径不变（fixture 模式自带内存写，用于演示；MySQL 模式无 REST 则写一律报错）。
   */
  mode?: 'fixture' | 'mysql';
  /** 直接注入后端实例（评测多题共享一个连接池就靠它） */
  backend?: EspoCrmBackend;
  mysql?: MySqlBackendOptions;
  rest?: EspoCrmRestOptions;
  /** 测试注入用；缺省 process.env */
  env?: Record<string, string | undefined>;
}

export function createEspoCrmAdapter(options: EspoCrmAdapterOptions = {}): SystemAdapter {
  return new EspoCrmAdapter(selectBackend(options));
}

function selectBackend(options: EspoCrmAdapterOptions): EspoCrmBackend {
  if (options.backend !== undefined) return options.backend;
  const env = options.env ?? process.env;
  const restConfig = options.rest ?? restConfigFromEnv(env);
  const mysqlConfig = options.mysql ?? mysqlConfigFromEnv(env);
  const mode = options.mode ?? (mysqlConfig ? 'mysql' : 'fixture');
  const reads =
    mode === 'mysql'
      ? (() => {
          if (!mysqlConfig) {
            throw new Error(
              'espocrm MySQL 模式需要 ESPOCRM_MYSQL_HOST + ESPOCRM_MYSQL_USER + ESPOCRM_MYSQL_PASSWORD',
            );
          }
          return new MySqlEspoCrmBackend(mysqlConfig);
        })()
      : new FixtureBackend();
  return restConfig ? withRestWrites(reads, new EspoCrmRestWriter(restConfig)) : reads;
}

/** 读走原后端、写走 EspoCRM REST 的组合——真库场景：只读 MySQL 查询 + REST 写入 */
export function withRestWrites(reads: EspoCrmBackend, writer: EspoCrmRestWriter): EspoCrmBackend {
  return {
    listAccounts: (industry) => reads.listAccounts(industry),
    getAccount: (id) => reads.getAccount(id),
    listContacts: (accountId) => reads.listContacts(accountId),
    getContact: (id) => reads.getContact(id),
    listOpportunities: (stage) => reads.listOpportunities(stage),
    getOpportunity: (id) => reads.getOpportunity(id),
    getPipelineSummary: () => reads.getPipelineSummary(),
    createContact: (input) => writer.createContact(input),
    updateContact: (id, patch) => writer.updateContact(id, patch),
    deleteContact: (id) => writer.deleteContact(id),
    updateOpportunityStage: (id, stage) => writer.updateOpportunityStage(id, stage),
  };
}

export function restConfigFromEnv(
  env: Record<string, string | undefined>,
): EspoCrmRestOptions | null {
  const baseUrl = env.ESPOCRM_REST_URL;
  const apiKey = env.ESPOCRM_REST_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
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

  async execute(call: ToolCall, principal: Principal): Promise<AdapterResult> {
    switch (call.tool) {
      case 'list_accounts': {
        const { industry } = listAccountsInput.parse(call.args);
        return { data: await this.backend.listAccounts(industry) };
      }
      case 'get_account': {
        const { account_id } = accountIdInput.parse(call.args);
        return { data: await this.backend.getAccount(account_id) };
      }
      case 'list_contacts': {
        const { account_id } = listContactsInput.parse(call.args);
        return { data: await this.backend.listContacts(account_id) };
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
      case 'create_contact': {
        const input = createContactInput.parse(call.args);
        // 归属戳来自身份透传而非参数——「替别人建联系人」的伪造口子结构上不存在
        return { data: await this.backend.createContact({ ...input, owner_id: principal.userId }) };
      }
      case 'update_contact': {
        const { contact_id, ...patch } = updateContactInput.parse(call.args);
        // 「至少改一个字段」的校验放这儿而非 schema：入参 schema 必须保持裸 z.object
        // （.refine 会变 ZodEffects，MCP 注册的 toRawShape 只收 ZodObject）
        if (Object.values(patch).every((v) => v === undefined)) {
          throw new Error('update_contact: 至少提供一个要修改的字段（name/title/email/phone）');
        }
        return { data: await this.backend.updateContact(contact_id, patch) };
      }
      case 'delete_contact': {
        const { contact_id } = contactIdInput.parse(call.args);
        return { data: await this.backend.deleteContact(contact_id) };
      }
      case 'update_opportunity_stage': {
        const { opportunity_id, stage } = updateOpportunityStageInput.parse(call.args);
        return { data: await this.backend.updateOpportunityStage(opportunity_id, stage) };
      }
      default:
        throw new Error(`espocrm: 未知工具 "${call.tool}"`);
    }
  }

  /**
   * 改写已存在行的写工具的前像：守卫据此在 execute 前核归属。
   * create_contact 归属由 execute 从 principal 盖戳、必是自己，无需前置核（返回 undefined）；
   * 读工具同样返回 undefined，走结果后置过滤。参数缺失/错型时返回 undefined，
   * 交给 execute 的 zod 走 error 分支——前像只管归属，不替 execute 做参数校验。
   */
  async preimage(call: ToolCall): Promise<unknown> {
    const arg = (key: string): string | undefined =>
      typeof call.args[key] === 'string' ? (call.args[key] as string) : undefined;
    switch (call.tool) {
      case 'update_contact':
      case 'delete_contact': {
        const contactId = arg('contact_id');
        return contactId === undefined ? undefined : await this.backend.getContact(contactId);
      }
      case 'update_opportunity_stage': {
        const opportunityId = arg('opportunity_id');
        return opportunityId === undefined
          ? undefined
          : await this.backend.getOpportunity(opportunityId);
      }
      default:
        return undefined;
    }
  }
}
