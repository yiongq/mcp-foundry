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
import type { AuditLogger, Principal, RbacConfig, SystemAdapter } from '@yiong/foundry-core';
import { Guard } from '@yiong/foundry-core';
import { type AuthConfig, resolvePrincipal } from './principal.js';
import { allowedToolEntries, assertUniqueToolNames, toRawShape } from './registry.js';

export interface FoundryServerOptions {
  adapters: readonly SystemAdapter[];
  rbac: RbacConfig;
  audit: AuditLogger;
  /** 鉴权模式；缺省 headers（demo 信任层），生产传 { mode: 'token', secret } */
  auth?: AuthConfig;
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
  adapters: readonly SystemAdapter[],
  guard: Guard,
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
    adapters.flatMap((a) => guard.allowedTools(a, principal).map((t) => t.name)),
  );
  if (allowed.has(toolName)) return null;
  const owner = adapters.find((a) => a.tools().some((t) => t.name === toolName));
  if (!owner) return null;

  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  const result = await guard.invoke(owner, principal, { tool: toolName, args });
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
  };
}

export function createFoundryServer(options: FoundryServerOptions): Server {
  assertUniqueToolNames(options.adapters);
  const auth = options.auth ?? { mode: 'headers' as const };
  const guard = new Guard(options.rbac, options.audit);
  const serverInfo = { name: options.name ?? 'mcp-foundry', version: options.version ?? '0.0.1' };

  const buildMcpServer = (principal: Principal): McpServer => {
    const mcp = new McpServer(serverInfo);
    for (const { adapter, spec } of allowedToolEntries(options.adapters, guard, principal)) {
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

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const verdict = resolvePrincipal(req.headers, auth);
    if (!verdict.ok) {
      sendJsonRpcError(res, 401, verdict.message);
      return;
    }
    const principal = verdict.principal;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJsonRpcError(res, 400, 'parse error: body must be JSON');
      return;
    }

    const denied = await interceptDeniedToolCall(options.adapters, guard, principal, body);
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
