import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type HttpServerHandle, startHttpTransport } from '../../src/transports/http';
import { clientOptionsFor, makeConfig } from '../integration/harness';
import { callMcp, refresh, signInWithDcr } from '../integration/oauth-client';
import { createZendeskOAuthMock, handlers } from '../msw-handlers';

const realFetch = globalThis.fetch;
const mock = createZendeskOAuthMock();

const servers: HttpServerHandle[] = [];
let cursor = 0;
const proxy = createServer(async (req, res) => {
  const server = servers[cursor++ % servers.length];
  if (!server) {
    res.writeHead(503);
    res.end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key))
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('x-forwarded-host', req.headers.host ?? '');
    const reply = await fetch(`http://127.0.0.1:${server.port}${req.url}`, {
      method: req.method ?? 'GET',
      headers,
      redirect: 'manual',
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    res.writeHead(reply.status, {
      ...Object.fromEntries(reply.headers),
      'set-cookie': reply.headers.getSetCookie(),
    });
    res.end(Buffer.from(await reply.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end();
  }
});
let baseUrl = '';
let config: ReturnType<typeof makeConfig>;
beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'testsubdomain.zendesk.com') {
      const response = await getResponse([...mock.handlers, ...handlers], request);
      if (!response) throw new Error('Unexpected Zendesk request in test');
      return response;
    }
    return realFetch(input, init);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  config = {
    ...makeConfig(),
    transport: 'http',
    port: 0,
    host: '127.0.0.1',
    publicUrl: baseUrl,
    oauthStore: `firestore://demo-zendesk-mcp/(default)/http_${randomUUID().replaceAll('-', '')}`,
    oauthMasterSecret: Buffer.alloc(32, 8).toString('base64'),
    readOnly: true,
    slaPush: false,
    slaUserPreferences: false,
  };
  servers.push(await startHttpTransport(config), await startHttpTransport(config));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await Promise.all(servers.map((server) => server.close()));
});

describe('round-robin HTTP and OAuth', () => {
  it('logs in across instances, reads MCP, refreshes, and reconnects after replacement', async () => {
    const login = await signInWithDcr(baseUrl);
    expect(login.tokens.status).toBe(200);
    const token = login.tokens.body.access_token;
    expect(token).toBeTypeOf('string');
    expect((await callMcp(baseUrl, token)).status).toBe(200);
    for (const era of ['2025', '2026'] as const) {
      const client = new Client({ name: 'firestore-test', version: '1' }, clientOptionsFor(era));
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'get_ticket')).toBe(true);
        expect(tools.tools.some((tool) => tool.name === 'create_ticket')).toBe(false);
        const result = await client.callTool({ name: 'get_ticket', arguments: { ticket_id: 1 } });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain('Test ticket');
      } finally {
        await client.close();
      }
    }
    await servers[0]?.close();
    servers[0] = await startHttpTransport(config);
    expect((await callMcp(baseUrl, token)).status).toBe(200);
    const rotated = await refresh(baseUrl, login.clientId, login.tokens.body.refresh_token ?? '');
    expect(rotated.status).toBe(200);
    expect((await callMcp(baseUrl, rotated.body.access_token)).status).toBe(200);
    const replay = await refresh(baseUrl, login.clientId, login.tokens.body.refresh_token ?? '');
    expect(replay.status).toBe(400);
    expect((await callMcp(baseUrl, rotated.body.access_token)).status).toBe(401);
  });
});
