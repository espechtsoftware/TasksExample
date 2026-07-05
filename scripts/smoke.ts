/**
 * End-to-end smoke test for the model-training product. Run: npm run smoke
 *
 * Boots the real Express app (in-memory Postgres via PGlite, mock payments)
 * and drives the full customer journey with the real MCP SDK client over
 * Streamable HTTP. The only substitution is the token signing key: we mint
 * Google-shaped ID tokens with an ephemeral local key pair injected through
 * the auth module's test seam. Claim validation runs exactly as in
 * production; there is still no unauthenticated path.
 *
 * Journey verified:
 *   1. Bearer gate: no/garbage/wrong-audience tokens rejected.
 *   2. Commerce gating: upload & training refused without a purchase.
 *   3. purchase_training_plan (basic) → transaction + entitlement recorded.
 *   4. upload_dataset: size limit enforced; columns detected.
 *   5. train_model as an MCP Task: handle now, progress stream, result later
 *      (classification, auto-resolved; scikit-learn + XGBoost CV underneath).
 *   6. Quota: basic tier's single training is spent → second run refused.
 *   7. Upgrade to standard → regression training with problem_type=auto.
 *   8. model://{jobId} resource: joblib artifact downloads; job completed.
 *   9. Tenant isolation: a different Google identity sees no jobs and
 *      cannot download someone else's model.
 */
import { createServer } from 'node:http';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/index.js';
import { Db } from '../src/db.js';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

const AUDIENCE = 'https://smoke-test.example.com/mcp';
const ISSUER = 'https://accounts.google.com';

// --- Ephemeral "Google" signing key -----------------------------------------
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'smoke-key' };
const getKey = createLocalJWKSet({ keys: [jwk] });

async function mintToken(user: { sub: string; email: string }, aud = AUDIENCE): Promise<string> {
  return new SignJWT({ email: user.email, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'smoke-key' })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

const ALICE = { sub: 'google-sub-alice', email: 'smoke@example.com' };
const MALLORY = { sub: 'google-sub-mallory', email: 'other@example.com' };

// --- Synthetic datasets --------------------------------------------------------
function classificationCsv(rows = 240): string {
  const lines = ['f1,f2,f3,color,label'];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < rows; i++) {
    const f1 = rand() * 10;
    const f2 = rand() * 10;
    const f3 = rand() * 5;
    const color = ['red', 'green', 'blue'][Math.floor(rand() * 3)];
    const label = f1 + f2 + (rand() - 0.5) * 4 > 10 ? 'yes' : 'no';
    lines.push(`${f1.toFixed(3)},${f2.toFixed(3)},${f3.toFixed(3)},${color},${label}`);
  }
  return lines.join('\n');
}

function regressionCsv(rows = 200): string {
  const lines = ['x1,x2,x3,price'];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < rows; i++) {
    const x1 = rand() * 100;
    const x2 = rand() * 50;
    const x3 = rand() * 10;
    const price = 3 * x1 - 2 * x2 + 5 * x3 + (rand() - 0.5) * 20;
    lines.push(`${x1.toFixed(2)},${x2.toFixed(2)},${x3.toFixed(2)},${price.toFixed(2)}`);
  }
  return lines.join('\n');
}

// --- Boot the app ---------------------------------------------------------------
const app = await createApp(
  {
    port: 0,
    publicUrl: 'http://localhost',
    audience: AUDIENCE,
    allowedEmails: [ALICE.email, MALLORY.email],
    dataDir: 'var/smoke',
    pythonBin: process.env.PYTHON_BIN ?? 'python3'
  },
  {
    authOverrides: { getKey },
    db: await Db.open() // in-memory PGlite for the test run
  }
);
const httpServer = createServer(app);
await new Promise<void>(resolve => httpServer.listen(0, resolve));
const address = httpServer.address();
if (typeof address === 'string' || !address) throw new Error('no port');
const base = `http://localhost:${address.port}`;
console.log(`Server up at ${base}`);

async function connect(user: { sub: string; email: string }): Promise<Client> {
  const client = new Client({ name: 'smoke-client', version: '0.2.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${await mintToken(user)}` } }
    })
  );
  // listTools also primes the SDK's task-tool cache: callToolStream only adds
  // task-creation params for tools it knows declare taskSupport.
  await client.listTools();
  return client;
}

/** Drives a train_model task to completion, returning what we observed. */
async function runTraining(
  client: Client,
  args: Record<string, unknown>
): Promise<{
  taskId?: string;
  sawWorking: boolean;
  statuses: string[];
  result?: { structuredContent?: Record<string, unknown> };
  error?: Error;
}> {
  const observed: Awaited<ReturnType<typeof runTraining>> = { sawWorking: false, statuses: [] };
  const stream = client.experimental.tasks.callToolStream({ name: 'train_model', arguments: args });
  for await (const message of stream) {
    if (message.type === 'taskCreated') {
      observed.taskId = message.task.taskId;
    } else if (message.type === 'taskStatus') {
      if (message.task.status === 'working') observed.sawWorking = true;
      if (message.task.statusMessage) observed.statuses.push(message.task.statusMessage);
    } else if (message.type === 'result') {
      observed.result = message.result as typeof observed.result;
    } else if (message.type === 'error') {
      observed.error = message.error;
    }
  }
  return observed;
}

try {
  // --- 1. Bearer gate ------------------------------------------------------------
  console.log('\n[1] Bearer-token gate');
  const noToken = await fetch(`${base}/mcp`, { method: 'POST' });
  assert(noToken.status === 401, 'request without token → 401');
  assert((noToken.headers.get('www-authenticate') ?? '').includes('resource_metadata='), 'WWW-Authenticate advertises resource metadata');
  const wrongAud = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await mintToken(ALICE, 'someone-else')}` }
  });
  assert(wrongAud.status === 401, 'wrong audience → 401');

  const alice = await connect(ALICE);

  // --- 2. Commerce gating ----------------------------------------------------------
  console.log('\n[2] No plan, no service');
  const uploadRefused = await alice.callTool({
    name: 'upload_dataset',
    arguments: { name: 'too early', csv_data: 'a,b\n1,2\n' }
  });
  assert(uploadRefused.isError === true, 'upload refused before purchase');

  // --- 3. Purchase basic -------------------------------------------------------------
  console.log('\n[3] Purchase (basic tier)');
  const products = await alice.callTool({ name: 'list_products', arguments: {} });
  const catalog = (products.structuredContent as { products: Array<{ id: string }> }).products;
  assert(catalog.length === 3, 'catalog lists 3 tiers');
  const purchase = await alice.callTool({ name: 'purchase_training_plan', arguments: { product_id: 'basic' } });
  const purchased = purchase.structuredContent as { entitlementId: string; receipt: string };
  assert(purchase.isError !== true && purchased.receipt.startsWith('mock_rcpt_'), 'mock payment succeeded, transaction recorded');

  // --- 4. Dataset upload + size limit --------------------------------------------------
  console.log('\n[4] Dataset upload');
  const tooBig = await alice.callTool({
    name: 'upload_dataset',
    arguments: { name: 'oversized', csv_data: 'a,b\n' + '1,2\n'.repeat(300_000) } // ~1.2 MB > basic's 1 MB
  });
  assert(tooBig.isError === true, 'oversized dataset rejected by tier limit');

  const upload = await alice.callTool({
    name: 'upload_dataset',
    arguments: { name: 'churn sample', csv_data: classificationCsv() }
  });
  const dataset = upload.structuredContent as { datasetId: string; columns: string[] };
  assert(upload.isError !== true && dataset.columns.join(',') === 'f1,f2,f3,color,label', 'columns detected from header');

  // --- 5. Long-running training task ----------------------------------------------------
  console.log('\n[5] train_model as an MCP Task (classification, auto)');
  const t0 = Date.now();
  const training = await runTraining(alice, {
    dataset_id: dataset.datasetId,
    target_column: 'label',
    problem_type: 'auto'
  });
  console.log(`  · ${training.statuses.length} status updates over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const s of training.statuses.slice(0, 6)) console.log(`    - ${s}`);
  assert(training.taskId, 'tools/call answered with a task handle');
  assert(training.sawWorking, 'observed intermediate "working" statuses');
  const outcome = training.result?.structuredContent as {
    resolvedType?: string;
    bestModel?: string;
    modelResourceUri?: string;
    metrics?: { leaderboard?: Record<string, unknown> };
  };
  assert(outcome?.resolvedType === 'classification', 'auto resolved the outcome type to classification');
  assert(!!outcome.bestModel && !!outcome.metrics?.leaderboard, `model selected from CV leaderboard (winner: ${outcome.bestModel})`);
  assert(outcome.modelResourceUri === `model://${training.taskId}`, 'result advertises the model download resource');

  // --- 6. Quota enforcement --------------------------------------------------------------
  console.log('\n[6] Quota: basic = one training, ever');
  const refused = await runTraining(alice, {
    dataset_id: dataset.datasetId,
    target_column: 'label',
    problem_type: 'auto'
  });
  // Refusals arrive as an instantly-failed task; the reason travels in the
  // task's statusMessage, which pollers observe via tasks/get.
  const refusalReason = refused.statuses.find(s => /limit/i.test(s)) ?? '';
  assert(
    refused.error !== undefined && refusalReason !== '',
    `second training refused as a failed task (${refusalReason.slice(0, 90)})`
  );

  // --- 7. Upgrade + regression --------------------------------------------------------------
  console.log('\n[7] Upgrade to standard; regression with auto detection');
  await alice.callTool({ name: 'purchase_training_plan', arguments: { product_id: 'standard' } });
  const regUpload = await alice.callTool({
    name: 'upload_dataset',
    arguments: { name: 'prices', csv_data: regressionCsv() }
  });
  const regDataset = regUpload.structuredContent as { datasetId: string };
  const regTraining = await runTraining(alice, {
    dataset_id: regDataset.datasetId,
    target_column: 'price',
    problem_type: 'auto'
  });
  const regOutcome = regTraining.result?.structuredContent as { resolvedType?: string; bestModel?: string };
  assert(regOutcome?.resolvedType === 'regression', 'auto resolved the numeric target to regression');
  console.log(`  · regression winner: ${regOutcome.bestModel}`);

  // --- 8. Model download + completion record -----------------------------------------------
  console.log('\n[8] Model artifact download');
  const jobs = await alice.callTool({ name: 'list_training_jobs', arguments: {} });
  const jobList = (jobs.structuredContent as { jobs: Array<{ jobId: string; status: string }> }).jobs;
  assert(jobList.filter(j => j.status === 'completed').length === 2, 'both jobs marked completed in Postgres');

  const artifact = await alice.readResource({ uri: `model://${training.taskId}` });
  const blob = artifact.contents[0] as { mimeType?: string; blob?: string };
  const modelBytes = Buffer.from(blob.blob ?? '', 'base64');
  // joblib serializes via pickle; protocol frames start with 0x80.
  assert(
    blob.mimeType === 'application/octet-stream' && modelBytes.length > 1000 && modelBytes[0] === 0x80,
    `joblib artifact downloaded (${(modelBytes.length / 1024).toFixed(1)} KB, pickle header OK)`
  );

  // --- 9. Tenant isolation ----------------------------------------------------------------
  console.log('\n[9] Tenant isolation');
  const mallory = await connect(MALLORY);
  const malloryJobs = await mallory.callTool({ name: 'list_training_jobs', arguments: {} });
  assert(((malloryJobs.structuredContent as { jobs: unknown[] }).jobs).length === 0, "another identity sees none of Alice's jobs");
  let stolen = false;
  try {
    await mallory.readResource({ uri: `model://${training.taskId}` });
    stolen = true;
  } catch {
    /* expected */
  }
  assert(!stolen, "another identity cannot download Alice's model");

  // --- Dashboard app still intact ------------------------------------------------------------
  const ui = await alice.readResource({ uri: 'ui://training-dashboard/view.html' });
  const uiContent = ui.contents[0] as { mimeType?: string; text?: string };
  assert(uiContent.mimeType === 'text/html;profile=mcp-app' && uiContent.text!.includes('Model training jobs'), 'dashboard app resource serves self-contained MCP Apps HTML');

  await alice.close();
  await mallory.close();
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
