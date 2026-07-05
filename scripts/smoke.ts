/**
 * End-to-end smoke test. Run with: npm run smoke
 *
 * Boots the real Express app and drives it with the real MCP SDK client over
 * Streamable HTTP. The only substitution is the token signing key: we mint
 * Google-shaped ID tokens with an ephemeral local key pair and inject the
 * matching JWKS through the auth module's test seam. Claim validation
 * (iss/aud/exp/email) runs exactly as in production; there is still no
 * unauthenticated path.
 *
 * Verifies:
 *   1. Requests without / with garbage bearer tokens are rejected (401 + WWW-Authenticate).
 *   2. Protected-resource metadata is publicly discoverable (RFC 9728).
 *   3. generate_report runs as an MCP Task: task handle now, status updates, result later.
 *   4. The task survives across stateless requests (separate poll via tasks/get).
 *   5. list_report_tasks reflects live progress (what the dashboard app polls).
 *   6. The ui:// dashboard resource serves self-contained MCP Apps HTML.
 */
import { createServer } from 'node:http';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/index.js';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

const AUDIENCE = 'https://smoke-test.example.com/mcp';
const ISSUER = 'https://accounts.google.com';

// --- Ephemeral "Google" signing key ----------------------------------------
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'smoke-key' };
const getKey = createLocalJWKSet({ keys: [jwk] });

async function mintToken(overrides: { aud?: string; iss?: string; email?: string } = {}): Promise<string> {
  return new SignJWT({ email: overrides.email ?? 'smoke@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'smoke-key' })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject('1234567890')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

// --- Boot the app ------------------------------------------------------------
const app = createApp(
  {
    port: 0,
    publicUrl: 'http://localhost',
    audience: AUDIENCE,
    allowedEmails: ['smoke@example.com']
  },
  { authOverrides: { getKey } }
);
const httpServer = createServer(app);
await new Promise<void>(resolve => httpServer.listen(0, resolve));
const address = httpServer.address();
if (typeof address === 'string' || !address) throw new Error('no port');
const base = `http://localhost:${address.port}`;
console.log(`Server up at ${base}`);

try {
  // --- 1. Auth gate -----------------------------------------------------------
  console.log('\n[1] Bearer-token gate');
  const noToken = await fetch(`${base}/mcp`, { method: 'POST' });
  assert(noToken.status === 401, 'request without token → 401');
  const challenge = noToken.headers.get('www-authenticate') ?? '';
  assert(challenge.includes('resource_metadata='), 'WWW-Authenticate advertises resource metadata');

  const garbage = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-jwt' }
  });
  assert(garbage.status === 401, 'garbage token → 401');

  const wrongAud = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await mintToken({ aud: 'someone-else' })}` }
  });
  assert(wrongAud.status === 401, 'valid signature but wrong audience → 401');

  const wrongEmail = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await mintToken({ email: 'intruder@example.com' })}` }
  });
  assert(wrongEmail.status === 403, 'authenticated but not allowlisted → 403');

  // --- 2. Public discovery ------------------------------------------------------
  console.log('\n[2] Protected-resource metadata (RFC 9728)');
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert(meta.authorization_servers[0] === 'https://accounts.google.com', 'metadata points at Google as IdP');

  // --- 3. Authenticated MCP session over Streamable HTTP -----------------------
  console.log('\n[3] MCP session with valid token');
  const token = await mintToken();
  const makeClient = async () => {
    const client = new Client({ name: 'smoke-client', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    return client;
  };
  const client = await makeClient();

  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['generate_report', 'list_report_tasks', 'report_dashboard']),
    `all three tools listed (${names.join(', ')})`
  );
  const dashboardTool = tools.tools.find(t => t.name === 'report_dashboard')!;
  const uiMeta = (dashboardTool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
  assert(uiMeta?.resourceUri === 'ui://report-dashboard/view.html', 'dashboard tool declares its ui:// resource');

  // --- 4. Long-running task lifecycle -------------------------------------------
  console.log('\n[4] MCP Task lifecycle (call-now / fetch-later)');
  let taskId: string | undefined;
  let sawWorkingStatus = false;
  let finalResult: { structuredContent?: { topic?: string } } | undefined;

  const stream = client.experimental.tasks.callToolStream({
    name: 'generate_report',
    arguments: { topic: 'Smoke test coverage', step_duration_ms: 100 }
  });
  for await (const message of stream) {
    if (message.type === 'taskCreated') {
      taskId = message.task.taskId;
      console.log(`  · task created: ${taskId}`);
    } else if (message.type === 'taskStatus') {
      if (message.task.status === 'working') sawWorkingStatus = true;
      if (message.task.statusMessage) console.log(`  · ${message.task.statusMessage}`);
    } else if (message.type === 'result') {
      finalResult = message.result as typeof finalResult;
    } else if (message.type === 'error') {
      throw new Error(`task stream error: ${JSON.stringify(message.error)}`);
    }
  }
  assert(taskId, 'tools/call answered with a task handle instead of a result');
  assert(sawWorkingStatus, 'observed intermediate "working" status while polling');
  assert(finalResult?.structuredContent?.topic === 'Smoke test coverage', 'tasks/result returned the finished report');

  // --- 5. Task state is shared across stateless requests ------------------------
  console.log('\n[5] Cross-request task visibility (stateless server)');
  const client2 = await makeClient();
  const task = await client2.experimental.tasks.getTask(taskId!);
  assert(task.status === 'completed', 'a *separate* MCP connection sees the completed task via tasks/get');

  const listing = await client2.callTool({ name: 'list_report_tasks', arguments: {} });
  const reports = (listing.structuredContent as { reports: Array<{ status: string; requestedBy: string }> }).reports;
  assert(reports.length === 1 && reports[0].status === 'completed', 'list_report_tasks shows the finished report');
  assert(reports[0].requestedBy === 'smoke@example.com', 'caller identity from the bearer token reached the tool');

  // --- 6. MCP Apps resource -------------------------------------------------------
  console.log('\n[6] MCP Apps dashboard resource');
  const resource = await client2.readResource({ uri: 'ui://report-dashboard/view.html' });
  const content = resource.contents[0] as { mimeType?: string; text?: string };
  assert(content.mimeType === 'text/html;profile=mcp-app', 'resource served with the MCP Apps MIME type');
  assert(content.text!.includes('Report generation tasks'), 'HTML view content present');
  assert(!/<script[^>]*src=/.test(content.text!), 'HTML is self-contained (no external scripts)');

  await client.close();
  await client2.close();
  console.log('\nAll smoke checks passed ✅');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  httpServer.close();
  // The in-memory task store keeps TTL cleanup timers armed; exit explicitly
  // so a passing run doesn't hang on them.
  process.exit(process.exitCode ?? 0);
}
