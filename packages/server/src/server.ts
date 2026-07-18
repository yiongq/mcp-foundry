/**
 * Guard × 官方 MCP SDK 的绑定层（Streamable HTTP，无状态模式）。
 *
 * 每个请求都 new 一个只注册了该 principal 白名单工具的 McpServer——
 * 权限收窄发生在 tools/list 之前，而不是调用被拒之后。
 * 身份解析见 principal.ts：token 模式验网关签名（生产），headers 模式信任
 * x-foundry-* 头（demo）；两种模式出口同为 Principal，守卫不感知鉴权方式。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  ApprovalStore,
  AuditLogger,
  Principal,
  RbacConfig,
  SystemAdapter,
} from '@yiong/foundry-core';
import { Guard } from '@yiong/foundry-core';
import { type AuthConfig, resolvePrincipal } from './principal.js';
import {
  allowedToolEntries,
  assertUniqueToolNames,
  type GuardedSystem,
  toRawShape,
} from './registry.js';

/** 一个受服务的系统 = 适配器 × 该系统自己的 RBAC；守卫由服务器统一构建（共享同一审计流水）。 */
export interface SystemBinding {
  adapter: SystemAdapter;
  rbac: RbacConfig;
}

export interface FoundryServerOptions {
  /**
   * RBAC 按系统分治——通配角色（tools: "*"）的权力边界止步于本域，
   * 别的域没登记这个角色就是 unknown_role（业务全权 ≠ 跨域全权）。
   */
  systems: readonly SystemBinding[];
  audit: AuditLogger;
  /** 鉴权模式；缺省 headers（demo 信任层），生产传 { mode: 'token', secret } */
  auth?: AuthConfig;
  /**
   * 审批闸门的单据存储。不传则闸门不可用——角色配置了 approval 列表时，
   * 涉审调用会得到 error（fail-closed），所以生产必须与 rbac 配置成对出现。
   * 同时启用 GET /approvals 与 POST /approvals/{id} 两个决策端点
   * （鉴权同 /mcp，且要求 principal 的角色在单据所属域标了 approver: true）。
   */
  approvals?: ApprovalStore;
  /** MCP serverInfo；默认 mcp-foundry / 0.0.1 */
  name?: string;
  version?: string;
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * 越权未遂必须留痕：白名单外但真实存在的工具被 tools/call 时，
 * 若交给 SDK 只会得到 "not found"——审计上等于没发生过。
 * 这里改走守卫（必然拒答并记 DENY），返回与正常 handler 同构的 JSON-RPC 响应。
 * 真不存在的工具返回 null，交给 SDK 报 not found。
 */
export async function interceptDeniedToolCall(
  systems: readonly GuardedSystem[],
  principal: Principal,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const msg = body as {
    method?: unknown;
    id?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (msg.method !== 'tools/call' || msg.id === undefined || msg.id === null) return null;
  const toolName = msg.params?.name;
  if (typeof toolName !== 'string') return null;

  const allowed = new Set(
    systems.flatMap(({ adapter, guard }) =>
      guard.allowedTools(adapter, principal).map((t) => t.name),
    ),
  );
  if (allowed.has(toolName)) return null;
  // 按名找到工具所属系统，交给该系统自己的守卫裁决——跨域越权未遂也按域记审计
  const owner = systems.find(({ adapter }) => adapter.tools().some((t) => t.name === toolName));
  if (!owner) return null;

  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  const result = await owner.guard.invoke(owner.adapter, principal, { tool: toolName, args });
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * 带上限的请求体读取：累计字节超过 limit 即停止缓冲并返回 null（调用方回 413）。
 * /mcp 的 JSON-RPC 体与 /approvals 的决策体都远小于 1 MiB——此前两处都无界缓冲，
 * 单个大 POST 即可撑爆内存（出站 JWKS 拉取早已按字节封顶，入站这条一直是缺口）。
 */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBodyCapped(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** 审批单的对外投影：审批人必须看清在批什么，args 原文属于必要信息，不做二次省略 */
function approvalView(record: {
  id: string;
  system: string;
  tool: string;
  args: Record<string, unknown>;
  userId: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  approverId?: string;
}): Record<string, unknown> {
  const { id, system, tool, args, userId, role, status, createdAt, expiresAt } = record;
  return {
    id,
    system,
    tool,
    args,
    requester: { userId, role },
    status,
    createdAt,
    expiresAt,
    ...(record.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
    ...(record.approverId !== undefined ? { approverId: record.approverId } : {}),
  };
}

export function createFoundryServer(options: FoundryServerOptions): Server {
  assertUniqueToolNames(options.systems.map((s) => s.adapter));
  const auth = options.auth ?? { mode: 'headers' as const };
  const systems: readonly GuardedSystem[] = options.systems.map(({ adapter, rbac }) => ({
    adapter,
    guard: new Guard(rbac, options.audit, { approvals: options.approvals }),
  }));
  const serverInfo = { name: options.name ?? 'mcp-foundry', version: options.version ?? '0.0.1' };

  const buildMcpServer = (principal: Principal): McpServer => {
    const mcp = new McpServer(serverInfo);
    for (const { adapter, guard, spec } of allowedToolEntries(systems, principal)) {
      mcp.registerTool(
        spec.name,
        { description: spec.description, inputSchema: toRawShape(spec.inputSchema, spec.name) },
        async (args: Record<string, unknown>) => {
          const result = await guard.invoke(adapter, principal, { tool: spec.name, args });
          // GuardedResult 原样 JSON 透传；refusal 是守卫的正当裁决而非工具故障，不标 isError
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            ...(result.kind === 'error' ? { isError: true } : {}),
          };
        },
      );
    }
    return mcp;
  };

  // 审批人授权按域裁决：principal 的角色须在单据所属系统的 RBAC 里标了 approver: true。
  // 发起人重试消票走 /mcp 正常调用；这两个端点只做「看单/批单」，不代执行。
  const rbacBySystem = new Map(options.systems.map((s) => [s.adapter.system, s.rbac]));
  const isApprover = (principal: Principal, system: string): boolean =>
    rbacBySystem.get(system)?.roles[principal.role]?.approver === true;

  const handleApprovals = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> => {
    const approvals = options.approvals;
    if (!approvals) {
      sendJson(res, 501, { error: 'approvals store not configured' });
      return;
    }
    const verdict = resolvePrincipal(req.headers, auth);
    if (!verdict.ok) {
      sendJson(res, 401, { error: verdict.message });
      return;
    }
    const principal = verdict.principal;

    if (path === '/approvals' && req.method === 'GET') {
      const pending = await approvals.listPending();
      const visible = pending.filter((r) => isApprover(principal, r.system));
      sendJson(res, 200, { approvals: visible.map(approvalView) });
      return;
    }

    const match = path.match(/^\/approvals\/([A-Za-z0-9-]+)$/);
    if (match?.[1] !== undefined && req.method === 'POST') {
      const bodyBuf = await readBodyCapped(req, MAX_BODY_BYTES);
      if (bodyBuf === null) {
        sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }
      let decision: unknown;
      try {
        ({ decision } = JSON.parse(bodyBuf.toString('utf8')) as {
          decision?: unknown;
        });
      } catch {
        sendJson(res, 400, { error: 'body must be JSON: {"decision":"approve"|"deny"}' });
        return;
      }
      if (decision !== 'approve' && decision !== 'deny') {
        sendJson(res, 400, { error: 'decision must be "approve" or "deny"' });
        return;
      }
      const record = await approvals.get(match[1]);
      if (!record) {
        sendJson(res, 404, { error: 'approval not found' });
        return;
      }
      if (!isApprover(principal, record.system)) {
        sendJson(res, 403, {
          error: `role ${principal.role} is not an approver for ${record.system}`,
        });
        return;
      }
      // 职责分离硬不变式：发起人不得批自己的单——即便他恰好也是审批人角色。
      // 这是代码级保证，不依赖 RBAC 把发起/审批角色配成不相交。
      if (record.userId === principal.userId) {
        sendJson(res, 403, {
          error: 'self-approval forbidden: the requester cannot approve their own request',
        });
        return;
      }
      if (record.status !== 'pending') {
        sendJson(res, 409, { error: `approval already ${record.status}` });
        return;
      }
      try {
        const decided = await approvals.decide(
          record.id,
          decision === 'approve' ? 'approved' : 'denied',
          principal.userId,
        );
        // 把审批决策写进（可能已签名的）审计链——否则「谁批准了这笔高危写」只存在
        // 未签名的 approvals.jsonl 里，防篡改审计无法归因、也无法被离线校验器覆盖。
        // argsHash 与后续放行执行的 ALLOW 记录同值，可据此关联「批准」与「执行」两条记录。
        await options.audit.log({
          ts: new Date().toISOString(),
          userId: record.userId,
          role: record.role,
          system: record.system,
          tool: record.tool,
          decision: decision === 'approve' ? 'ALLOW' : 'DENY',
          reason: decision === 'approve' ? 'approval_granted' : 'approval_denied',
          rule: `approval:${record.id}`,
          latencyMs: 0,
          argsHash: record.argsHash,
          approvalId: record.id,
          approverId: principal.userId,
        });
        sendJson(res, 200, approvalView(decided));
      } catch (err) {
        // decide 的状态校验竞态兜底（如恰好过期）
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 405, { error: 'only GET /approvals and POST /approvals/{id} are served' });
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const verdict = resolvePrincipal(req.headers, auth);
    if (!verdict.ok) {
      sendJsonRpcError(res, 401, verdict.message);
      return;
    }
    const principal = verdict.principal;
    const bodyBuf = await readBodyCapped(req, MAX_BODY_BYTES);
    if (bodyBuf === null) {
      sendJsonRpcError(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      sendJsonRpcError(res, 400, 'parse error: body must be JSON');
      return;
    }

    const denied = await interceptDeniedToolCall(systems, principal, body);
    if (denied) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(denied));
      return;
    }

    const mcp = buildMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：不发不收 session id，任意节点可处理任意请求
      enableJsonResponse: true, // 单次 JSON 响应，curl/评测脚本不必解析 SSE
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (path === '/approvals' || path.startsWith('/approvals/')) {
        await handleApprovals(req, res, path);
        return;
      }
      if (path !== '/mcp') {
        sendJsonRpcError(res, 404, 'not found: only POST /mcp is served');
        return;
      }
      if (req.method !== 'POST') {
        // 无状态模式不维护 SSE 长连接与会话，GET/DELETE 一律 405
        sendJsonRpcError(res, 405, 'method not allowed: stateless server only accepts POST');
        return;
      }
      await handleMcp(req, res);
    })().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJsonRpcError(res, 500, err instanceof Error ? err.message : String(err));
    });
  });
}
