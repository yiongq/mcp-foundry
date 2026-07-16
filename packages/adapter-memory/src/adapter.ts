import type {
  AdapterResult,
  Principal,
  SystemAdapter,
  ToolCall,
  ToolSpec,
} from '@yiong/foundry-core';
import { z } from 'zod';
import { MemoryStore } from './store.js';

export const saveMemoryInput = z.object({
  content: z.string().min(1),
  session_id: z.string().min(1).default('default'),
});

export const recallMemoriesInput = z.object({
  query: z.string().optional(),
  session_id: z.string().optional(),
});

export const getMemoryInput = z.object({
  memory_id: z.string().min(1),
});

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'save_memory',
    description:
      '保存一条跨会话记忆（content 必填，session_id 可选）。归属人取自当前身份，参数指定不了归属',
    inputSchema: saveMemoryInput,
  },
  {
    name: 'recall_memories',
    description:
      '召回记忆，默认跨全部会话；query 按内容子串过滤，session_id 限定单会话。只会返回提问人自己的记忆',
    inputSchema: recallMemoriesInput,
  },
  {
    name: 'get_memory',
    description: '按 memory_id 取单条记忆；不存在或不属于提问人时拒绝',
    inputSchema: getMemoryInput,
  },
];

/**
 * 记忆适配器。两条与业务适配器不同的设计决策：
 * 1. save_memory 没有 employee_id 参数——归属从 principal 盖戳，
 *    「替别人写记忆」（记忆投毒）在接口层面就不存在，而不是靠运行时拦截。
 * 2. recall/get 返回时不看提问人——越权召回由守卫行级规则统一挡，
 *    评测的 ablation 模式正好能量化这道兜底的价值。
 */
export function createMemoryAdapter(store: MemoryStore = new MemoryStore()): SystemAdapter {
  return new MemoryAdapter(store);
}

class MemoryAdapter implements SystemAdapter {
  readonly system = 'memory';

  constructor(private readonly store: MemoryStore) {}

  tools(): ToolSpec[] {
    return [...TOOL_SPECS];
  }

  async execute(call: ToolCall, principal: Principal): Promise<AdapterResult> {
    switch (call.tool) {
      case 'save_memory': {
        const { content, session_id } = saveMemoryInput.parse(call.args);
        return { data: this.store.save(principal.userId, content, session_id) };
      }
      case 'recall_memories': {
        const { query, session_id } = recallMemoriesInput.parse(call.args);
        return { data: this.store.recall(query, session_id) };
      }
      case 'get_memory': {
        const { memory_id } = getMemoryInput.parse(call.args);
        return { data: this.store.get(memory_id) };
      }
      default:
        throw new Error(`memory: 未知工具 "${call.tool}"`);
    }
  }
}
