import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** 与 core 的 Principal 同构，但独立声明——用例来自 YAML，须过 zod 才能进 Guard。 */
const principalSchema = z.object({
  userId: z.string().min(1),
  role: z.string().min(1),
  attrs: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const refusalReasonSchema = z.enum(['unknown_role', 'tool_not_allowed', 'row_denied']);

/** 主调用前的铺垫步骤（如先替某人存一条记忆），必须成功（ok），否则整题按失败记。 */
const seedStepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  principal: principalSchema,
});

export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** 只用于报告分组；CI 门禁不看类别、只看 expect（refuse/error 即红队题） */
    category: z.string().min(1).default('uncategorized'),
    /** 路由到哪个系统的适配器与 RBAC（orangehrm / memory） */
    system: z.string().min(1).default('orangehrm'),
    /** 铺垫步骤与主调用走同一系统的守卫，各题适配器新建，互不串数据 */
    seed: z.array(seedStepSchema).optional(),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    principal: principalSchema,
    expect: z.enum(['allow', 'refuse', 'error']),
    expectRefusalReason: refusalReasonSchema.optional(),
    /** ok 结果里这些字段名递归不得出现（如 salary/phone）——防脱敏漏网 */
    mustNotContainFields: z.array(z.string().min(1)).optional(),
    expectRowCount: z.number().int().nonnegative().optional(),
    /** ok 单对象结果须包含这些键值——用来钉死 fixture 数值 */
    expectDataIncludes: z.record(z.string(), z.unknown()).optional(),
    /** ok 结果序列化后须包含的子串——钉住召回内容 */
    mustContainText: z.array(z.string().min(1)).optional(),
    /**
     * 整个结果（含拒答/错误分支）序列化后不得出现的子串——
     * 抓自由文本里内嵌的隐私值（字段名扫描抓不到的那种泄漏）
     */
    mustNotContainText: z.array(z.string().min(1)).optional(),
    /** 给 LLM-judge 的补充评审要点；硬断言通过后 judge 才会看 */
    judgeRubric: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.expectRefusalReason !== undefined && c.expect !== 'refuse') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `用例 ${c.id}: expectRefusalReason 只在 expect=refuse 时有意义`,
      });
    }
    const allowOnly: Array<[string, unknown]> = [
      ['mustNotContainFields', c.mustNotContainFields],
      ['expectRowCount', c.expectRowCount],
      ['expectDataIncludes', c.expectDataIncludes],
      ['mustContainText', c.mustContainText],
    ];
    for (const [key, value] of allowOnly) {
      if (value !== undefined && c.expect !== 'allow') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `用例 ${c.id}: ${key} 只在 expect=allow 时有意义`,
        });
      }
    }
  });

export const caseFileSchema = z
  .object({ cases: z.array(evalCaseSchema).min(1) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const c of file.cases) {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `用例 id 重复: ${c.id}`,
          path: ['cases'],
        });
      }
      seen.add(c.id);
    }
  });

export type EvalPrincipal = z.infer<typeof principalSchema>;
export type EvalSeedStep = z.infer<typeof seedStepSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;

export function loadCases(yamlText: string): EvalCase[] {
  return caseFileSchema.parse(parseYaml(yamlText)).cases;
}
