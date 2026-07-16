import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapter.js';
import { MemoryStore } from './store.js';

const XIAO_WANG: Principal = { userId: 'e002', role: 'employee' };
const ZHANG_SAN: Principal = { userId: 'e001', role: 'employee' };

const fixedClock = (): string => '2026-07-16T00:00:00.000Z';

describe('MemoryStore', () => {
  it('save 生成递增 id，recall 默认跨会话、可按会话与内容子串过滤', () => {
    const store = new MemoryStore(fixedClock);
    store.save('e002', '出差习惯靠窗座位', 's1');
    store.save('e002', '报销走行政部流程', 's2');

    expect(store.recall().map((r) => r.memory_id)).toEqual(['m001', 'm002']);
    expect(store.recall(undefined, 's1')).toHaveLength(1);
    expect(store.recall('报销')).toHaveLength(1);
    expect(store.recall('不存在的词')).toEqual([]);
  });

  it('get 按 id 命中，不存在返回 null', () => {
    const store = new MemoryStore(fixedClock);
    const saved = store.save('e002', 'x', 's1');
    expect(store.get(saved.memory_id)?.content).toBe('x');
    expect(store.get('m999')).toBeNull();
  });
});

describe('memory 适配器', () => {
  it('save_memory 的归属来自 principal，args 里夹带 employee_id 也伪造不了', async () => {
    const adapter = createMemoryAdapter(new MemoryStore(fixedClock));

    const { data } = await adapter.execute(
      { tool: 'save_memory', args: { content: '我的工资是 9800', employee_id: 'e001' } },
      XIAO_WANG,
    );

    expect((data as { employee_id: string }).employee_id).toBe('e002');
  });

  it('save_memory 空 content 走 zod 报错', async () => {
    const adapter = createMemoryAdapter();
    await expect(
      adapter.execute({ tool: 'save_memory', args: { content: '' } }, XIAO_WANG),
    ).rejects.toThrow();
  });

  it('未知工具抛错', async () => {
    const adapter = createMemoryAdapter();
    await expect(adapter.execute({ tool: 'boom', args: {} }, XIAO_WANG)).rejects.toThrow(
      '未知工具',
    );
  });
});

describe('memory 适配器 × 守卫（越权记忆泄露的行级兜底）', () => {
  const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [save_memory, recall_memories, get_memory]
    rows:
      - field: employee_id
        equals: $self.userId
`);

  it('B 召回不到 A 的记忆（0 行），B 按 id 取 A 的记忆被 row_denied', async () => {
    const store = new MemoryStore(fixedClock);
    const adapter = createMemoryAdapter(store);
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const saved = await guard.invoke(adapter, ZHANG_SAN, {
      tool: 'save_memory',
      args: { content: '张三的私人备忘', session_id: 's1' },
    });
    expect(saved.kind).toBe('ok');

    const recall = await guard.invoke(adapter, XIAO_WANG, { tool: 'recall_memories', args: {} });
    expect(recall.kind).toBe('ok');
    if (recall.kind === 'ok') expect(recall.data).toEqual([]);

    const byId = await guard.invoke(adapter, XIAO_WANG, {
      tool: 'get_memory',
      args: { memory_id: 'm001' },
    });
    expect(byId.kind).toBe('refusal');
    if (byId.kind === 'refusal') expect(byId.reason).toBe('row_denied');
  });

  it('本人跨会话召回自己的记忆', async () => {
    const store = new MemoryStore(fixedClock);
    const adapter = createMemoryAdapter(store);
    const guard = new Guard(rbac, new MemoryAuditLogger());

    await guard.invoke(adapter, XIAO_WANG, {
      tool: 'save_memory',
      args: { content: '喜欢靠窗座位', session_id: 's1' },
    });
    const recall = await guard.invoke(adapter, XIAO_WANG, {
      tool: 'recall_memories',
      args: { query: '靠窗' },
    });

    expect(recall.kind).toBe('ok');
    if (recall.kind === 'ok') {
      expect(recall.data).toHaveLength(1);
      expect((recall.data as { content: string }[])[0]?.content).toContain('靠窗');
    }
  });
});
