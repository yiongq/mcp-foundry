import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import type { TwentyBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
import type { TwentyRestOptions } from './rest.js';
import { TwentyRestBackend } from './rest.js';
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

export interface TwentyAdapterOptions {
  /**
   * 后端选择优先级：backend 注入 > mode 显式 > 环境变量探测（TWENTY_API_URL + TWENTY_API_KEY）> fixture。
   * REST 对接见 docs/twenty-notes.md。
   */
  mode?: 'fixture' | 'rest';
  backend?: TwentyBackend;
  rest?: TwentyRestOptions;
  /** 测试注入用；缺省 process.env */
  env?: Record<string, string | undefined>;
}

export function createTwentyAdapter(options: TwentyAdapterOptions = {}): SystemAdapter {
  return new TwentyAdapter(selectBackend(options));
}

function selectBackend(options: TwentyAdapterOptions): TwentyBackend {
  if (options.backend !== undefined) return options.backend;
  const env = options.env ?? process.env;
  const restConfig = options.rest ?? restConfigFromEnv(env);
  const mode = options.mode ?? (restConfig ? 'rest' : 'fixture');
  if (mode === 'rest') {
    if (!restConfig) {
      throw new Error('twenty REST 模式需要 TWENTY_API_URL + TWENTY_API_KEY');
    }
    return new TwentyRestBackend(restConfig);
  }
  return new FixtureBackend();
}

export function restConfigFromEnv(
  env: Record<string, string | undefined>,
): TwentyRestOptions | null {
  const baseUrl = env.TWENTY_API_URL;
  const apiKey = env.TWENTY_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    ...(env.TWENTY_OWNER_FIELD ? { ownerField: env.TWENTY_OWNER_FIELD } : {}),
  };
}

class TwentyAdapter implements SystemAdapter {
  readonly system = 'twenty';

  constructor(private readonly backend: TwentyBackend) {}

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
        // 归属戳来自身份透传而非参数——伪造不了归属
        return { data: await this.backend.createContact({ ...input, owner_id: principal.userId }) };
      }
      case 'update_contact': {
        const { contact_id, ...patch } = updateContactInput.parse(call.args);
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
        throw new Error(`twenty: 未知工具 "${call.tool}"`);
    }
  }

  /** 改写已存在行的写工具前像：守卫据此在 execute 前核归属。 */
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
