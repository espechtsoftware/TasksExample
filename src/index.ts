/**
 * HTTP entrypoint: Streamable HTTP transport ONLY (no stdio), gated by
 * Google bearer-token auth with no anonymous fallback.
 *
 * Layout of the HTTP surface:
 *   POST /mcp                                    — the MCP endpoint (auth required)
 *   GET/DELETE /mcp                              — 405 (we run stateless: no SSE
 *                                                  resume stream, no session to delete)
 *   GET /.well-known/oauth-protected-resource/mcp — RFC 9728 metadata (public by design;
 *                                                  it's how clients discover the IdP)
 *   GET /healthz                                 — liveness probe (public, no data)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks';
import { loadConfig } from './config.js';
import { createGoogleAuthMiddleware, protectedResourceMetadata, type GoogleAuthOptions } from './auth/google.js';
import { buildMcpServer, type McpDeps } from './mcp/server.js';
import { ReportRegistry } from './mcp/reports.js';

export interface CreateAppOptions {
  /** Test seam used by the smoke test to sign tokens locally. Production never sets this. */
  authOverrides?: Pick<GoogleAuthOptions, 'getKey' | 'issuers'>;
}

export function createApp(config = loadConfig(), options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json());

  // Shared, cross-request state. In production these would be backed by a
  // real store (Redis/Firestore) so any replica can answer task polls.
  const deps: McpDeps = {
    taskStore: new InMemoryTaskStore(),
    taskMessageQueue: new InMemoryTaskMessageQueue(),
    registry: new ReportRegistry(),
    // `npm run build:ui` produces this self-contained file; scripts run from the repo root.
    dashboardHtml: readFileSync(path.resolve(process.cwd(), 'dist/ui/dashboard.html'), 'utf8')
  };

  const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const requireGoogleToken = createGoogleAuthMiddleware({
    audience: config.audience,
    allowedDomain: config.allowedDomain,
    allowedEmails: config.allowedEmails,
    resourceMetadataUrl,
    ...options.authOverrides
  });

  // Public discovery document — the one intentionally unauthenticated URL,
  // required by the MCP authorization spec so clients can find the IdP.
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json(protectedResourceMetadata(config.publicUrl));
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/mcp', requireGoogleToken, async (req, res) => {
    // Stateless mode: a fresh McpServer + transport per request, no
    // Mcp-Session-Id. Anything that must outlive the request (the running
    // report task) lives in `deps`, which is why polling from a later
    // request — or a different replica in production — still works.
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // Stateless servers have no standalone SSE stream to offer and no session
  // to delete; answering 405 here is the spec-sanctioned response.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server runs stateless Streamable HTTP' },
        id: null
      });
  };
  app.get('/mcp', requireGoogleToken, methodNotAllowed);
  app.delete('/mcp', requireGoogleToken, methodNotAllowed);

  return app;
}

// Only start listening when executed directly (node dist/src/index.js or
// tsx src/index.ts), not when imported by the smoke test.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const config = loadConfig();
  createApp(config).listen(config.port, () => {
    console.log(`MCP server (Streamable HTTP) listening on :${config.port}`);
    console.log(`  MCP endpoint:       ${config.publicUrl}/mcp  (Google bearer token required)`);
    console.log(`  Resource metadata:  ${config.publicUrl}/.well-known/oauth-protected-resource/mcp`);
    console.log(`  Expected audience:  ${config.audience}`);
  });
}
