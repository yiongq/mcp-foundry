import type { ToolSpec } from '@yiong/foundry-core';
import { z } from 'zod';

export const listAccountsInput = z.object({
  industry: z.string().min(1).optional(),
});

export const accountIdInput = z.object({
  account_id: z.string().min(1),
});

export const listContactsInput = z.object({
  account_id: z.string().min(1).optional(),
});

export const contactIdInput = z.object({
  contact_id: z.string().min(1),
});

export const listOpportunitiesInput = z.object({
  stage: z.string().min(1).optional(),
});

export const opportunityIdInput = z.object({
  opportunity_id: z.string().min(1),
});

export const pipelineSummaryInput = z.object({});

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'list_accounts',
    description:
      '列出客户（Account），可选按行业（industry）精确过滤；每行含 account_id、name、industry、owner_id',
    inputSchema: listAccountsInput,
  },
  {
    name: 'get_account',
    description:
      '按 account_id 查询单个客户的详情（含 website、phone、city）；客户不存在时返回 null',
    inputSchema: accountIdInput,
  },
  {
    name: 'list_contacts',
    description:
      '列出联系人，可选按所属客户（account_id）精确过滤；每行含 contact_id、name、title、account_id、owner_id，不含联系方式（邮箱/电话用 get_contact 按 id 查详情）',
    inputSchema: listContactsInput,
  },
  {
    name: 'get_contact',
    description:
      '按 contact_id 查询单个联系人（含 title、email、phone 与所属 account_id）；联系人不存在时返回 null',
    inputSchema: contactIdInput,
  },
  {
    name: 'list_opportunities',
    description:
      '列出商机（Opportunity），可选按销售阶段（stage，如 Proposal/Negotiation/Closed Won）精确过滤；每行含金额与预计成单日',
    inputSchema: listOpportunitiesInput,
  },
  {
    name: 'get_opportunity',
    description:
      '按 opportunity_id 查询单个商机（amount/currency/stage/probability/close_date）；商机不存在时返回 null',
    inputSchema: opportunityIdInput,
  },
  {
    name: 'get_pipeline_summary',
    description:
      '按销售（owner）汇总业绩盘子：在途商机数与金额、已赢单数与金额——全员口径的经营数据',
    inputSchema: pipelineSummaryInput,
  },
];
