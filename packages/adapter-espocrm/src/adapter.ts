import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import type { EspoCrmBackend } from './backend.js';
import { FixtureBackend } from './fixtures.js';
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
   * 直接注入后端实例；缺省 fixture（内置演示数据）。
   * 真实 EspoCRM 后端（只读 MySQL）在路线图上——见 docs/espocrm-notes.md，
   * 届时与 orangehrm 同款：环境变量探测 + mode 显式指定。
   */
  backend?: EspoCrmBackend;
}

export function createEspoCrmAdapter(options: EspoCrmAdapterOptions = {}): SystemAdapter {
  return new EspoCrmAdapter(options.backend ?? new FixtureBackend());
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
