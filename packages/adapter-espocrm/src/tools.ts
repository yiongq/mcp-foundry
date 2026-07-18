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

/** stage 钉死为 EspoCRM 缺省枚举——自由字符串会把脏值写进真库 */
export const OPPORTUNITY_STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;

export const createContactInput = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
});

// 注意：保持裸 z.object，不要 .refine——MCP 服务器的 toRawShape 只收 ZodObject，
// ZodEffects（.refine 的产物）会让整个 espocrm 工具面在 /mcp 注册时抛错。
// 「至少改一个字段」的校验放在 adapter.execute 里做（见 requireAtLeastOnePatchField）。
export const updateContactInput = z.object({
  contact_id: z.string().min(1),
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
});

export const updateOpportunityStageInput = z.object({
  opportunity_id: z.string().min(1),
  stage: z.enum(OPPORTUNITY_STAGES),
});

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
  {
    name: 'create_contact',
    description:
      '新建联系人（name 必填；title/account_id/email/phone 可选）；归属人自动取当前身份，不可指定',
    inputSchema: createContactInput,
  },
  {
    name: 'update_contact',
    description:
      '按 contact_id 修改联系人的 name/title/email/phone（至少一项）；联系人不存在时返回 null。此操作可能需要人工审批（返回 pending 时告知用户等待批复，勿重试）',
    inputSchema: updateContactInput,
  },
  {
    name: 'delete_contact',
    description:
      '按 contact_id 删除联系人，返回被删除的行；联系人不存在时返回 null。此操作可能需要人工审批（返回 pending 时告知用户等待批复，勿重试）',
    inputSchema: contactIdInput,
  },
  {
    name: 'update_opportunity_stage',
    description: `按 opportunity_id 更新商机销售阶段（stage 取值：${OPPORTUNITY_STAGES.join('/')}）；商机不存在时返回 null。此操作可能需要人工审批（返回 pending 时告知用户等待批复，勿重试）`,
    inputSchema: updateOpportunityStageInput,
  },
];
